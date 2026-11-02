import type { BrowserContext, Page, Request, WebSocket } from "@playwright/test";
import { readFileSync } from "node:fs";
import { collectResponseShape, DEFAULT_CAPTURE_DIR, mergePersistedManifests, parsePersistedManifest, writeCapture, type CapturedOperation, type PersistedManifest } from "@gqlcov/core";

export interface PlaywrightCaptureOptions {
  /** Match the GraphQL endpoint. String = substring of the URL; RegExp = test against the URL. Default "/graphql". */
  endpoint?: string | RegExp;
  dir?: string;
  /** Label written as `source`, e.g. `testInfo.titlePath.join(" > ")`. */
  source?: string;
  /** Who the page is logged in as, e.g. "admin" or "anonymous", so coverage can be split per identity. */
  identity?: string;
  /**
   * Persisted-operation manifest file(s): an Apollo persisted query manifest, Relay's persisted output, or any
   * `[{ id, body }]`. Requests that send only an id are resolved to their document at capture time. Without a
   * manifest the id is still recorded, so `gqlcov report --persisted` can resolve it later.
   */
  manifest?: string | string[];
  /**
   * Read each response and record which fields held a value, a null, an empty list or an error. Default true.
   * Captures are then written when the request finishes (or fails, without response data); set false to write
   * them as soon as the request is sent, without response data.
   */
  responses?: boolean;
}

/** Ids seen together with their document in this process (APQ cache misses), reused for later id-only requests. */
const learned: PersistedManifest = new Map();

/** The persisted id of a request body, whichever convention the client uses. */
export function persistedIdOf(b: Record<string, unknown>): string | undefined {
  const ext = b.extensions as Record<string, unknown> | undefined;
  const pq = ext?.persistedQuery as Record<string, unknown> | undefined;
  for (const v of [pq?.sha256Hash, b.documentId, b.doc_id, b.id]) if (typeof v === "string" && v) return v;
  return undefined;
}

/** One GraphQL request payload (`{ query, operationName, variables, extensions }` or a persisted id) as a capture. */
function operationFromBody(body: unknown, manifest?: PersistedManifest): CapturedOperation | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const persistedId = persistedIdOf(b);
  let document = typeof b.query === "string" ? b.query : undefined;
  if (persistedId && document) learned.set(persistedId, document);
  if (!document && persistedId) document = manifest?.get(persistedId) ?? learned.get(persistedId);
  if (!document && !persistedId) return undefined;
  return { document, persistedId, operationName: (b.operationName as string | null) ?? null, variables: (b.variables as Record<string, unknown> | null) ?? null };
}

/** Parse one HTTP request body into zero or more operations (handles batched arrays, GET queries and persisted ids). */
export function operationsFromRequest(request: Request, manifest?: PersistedManifest): CapturedOperation[] {
  const out: CapturedOperation[] = [];
  const push = (body: unknown) => {
    const op = operationFromBody(body, manifest);
    if (op) out.push(op);
  };
  if (request.method() === "GET") {
    const url = new URL(request.url());
    const json = (k: string): unknown => { try { return JSON.parse(url.searchParams.get(k) ?? "null"); } catch { return null; } };
    const q = url.searchParams.get("query");
    const body: Record<string, unknown> = { operationName: url.searchParams.get("operationName"), variables: json("variables"), extensions: json("extensions") };
    if (q) body.query = q;
    for (const k of ["documentId", "doc_id", "id"]) { const v = url.searchParams.get(k); if (v) body[k] = v; }
    push(body);
    return out;
  }
  const raw = request.postData();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsed.forEach(push);
    else push(parsed);
  } catch {
    // not JSON (multipart uploads etc.): skipped
  }
  return out;
}

/**
 * The response shape of each operation in a response body, in request order: one entry for a single request,
 * one per item for a batch. Bodies that are not GraphQL results give no shapes.
 */
export function shapesFromResponse(body: unknown): (Record<string, number> | undefined)[] {
  const one = (r: unknown) => {
    if (!r || typeof r !== "object" || !("data" in r || "errors" in r)) return undefined;
    const x = r as { data?: unknown; errors?: { path?: (string | number)[] }[] };
    return collectResponseShape(x.data, Array.isArray(x.errors) ? x.errors : undefined);
  };
  return Array.isArray(body) ? body.map(one) : [one(body)];
}

/**
 * The operation a client starts in one WebSocket frame, or undefined for any other frame. Understands
 * graphql-ws (`{ type: "subscribe", payload }`) and the older subscriptions-transport-ws (`{ type: "start", payload }`).
 */
export function operationFromFrame(frame: string | Buffer, manifest?: PersistedManifest): CapturedOperation | undefined {
  let message: unknown;
  try {
    message = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8"));
  } catch {
    return undefined;
  }
  const m = message as { type?: unknown; payload?: unknown } | null;
  if (!m || (m.type !== "subscribe" && m.type !== "start")) return undefined;
  return operationFromBody(m.payload, manifest);
}

/**
 * Record every GraphQL request the page (or context) sends, over HTTP and over WebSocket (subscriptions). Call once per test, typically in a fixture:
 *
 *   test.beforeEach(async ({ page }, testInfo) => { await captureGraphQL(page, { source: testInfo.title }); });
 */
export async function captureGraphQL(target: Page | BrowserContext, options: PlaywrightCaptureOptions = {}): Promise<void> {
  const endpoint = options.endpoint ?? "/graphql";
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  const matches = (url: string) => (typeof endpoint === "string" ? url.includes(endpoint) : endpoint.test(url));
  const manifestFiles = options.manifest === undefined ? [] : Array.isArray(options.manifest) ? options.manifest : [options.manifest];
  const manifest = manifestFiles.length ? mergePersistedManifests(manifestFiles.map((f) => parsePersistedManifest(readFileSync(f, "utf8")))) : undefined;
  const save = (op: CapturedOperation) => {
    try {
      writeCapture(dir, { ...op, source: options.source, identity: options.identity });
    } catch {
      // ignore
    }
  };
  if (options.responses === false) {
    target.on("request", (request) => {
      if (!matches(request.url())) return;
      for (const op of operationsFromRequest(request, manifest)) save(op);
    });
  } else {
    target.on("requestfinished", async (request) => {
      if (!matches(request.url())) return;
      const ops = operationsFromRequest(request, manifest);
      if (!ops.length) return;
      let shapes: (Record<string, number> | undefined)[] = [];
      try {
        shapes = shapesFromResponse(await (await request.response())?.json());
      } catch {
        // no body, not JSON, or the page went away: keep the operations without response data
      }
      ops.forEach((op, i) => save(shapes[i] ? { ...op, responseShape: shapes[i] } : op));
    });
    target.on("requestfailed", (request) => {
      if (!matches(request.url())) return;
      for (const op of operationsFromRequest(request, manifest)) save(op);
    });
  }
  const watchSockets = (page: Page) =>
    page.on("websocket", (ws: WebSocket) => {
      if (!matches(ws.url())) return;
      ws.on("framesent", ({ payload }) => {
        const op = operationFromFrame(payload, manifest);
        if (op) save(op);
      });
    });
  // A page reports its own sockets; a browser context only reports pages, so watch each of them.
  if ("pages" in target) {
    target.pages().forEach(watchSockets);
    target.on("page", watchSockets);
  } else {
    watchSockets(target);
  }
}
