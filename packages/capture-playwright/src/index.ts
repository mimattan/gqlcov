import type { BrowserContext, Page, Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_CAPTURE_DIR, mergePersistedManifests, parsePersistedManifest, writeCapture, type CapturedOperation, type PersistedManifest } from "@gqlcov/core";

export interface PlaywrightCaptureOptions {
  /** Match the GraphQL endpoint. String = substring of the URL; RegExp = test against the URL. Default "/graphql". */
  endpoint?: string | RegExp;
  dir?: string;
  /** Label written as `source`, e.g. `testInfo.titlePath.join(" > ")`. */
  source?: string;
  /**
   * Persisted-operation manifest file(s): an Apollo persisted query manifest, Relay's persisted output, or any
   * `[{ id, body }]`. Requests that send only an id are resolved to their document at capture time. Without a
   * manifest the id is still recorded, so `gqlcov report --persisted` can resolve it later.
   */
  manifest?: string | string[];
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

/** Parse one HTTP request body into zero or more operations (handles batched arrays, GET queries and persisted ids). */
export function operationsFromRequest(request: Request, manifest?: PersistedManifest): CapturedOperation[] {
  const out: CapturedOperation[] = [];
  const push = (body: unknown) => {
    if (!body || typeof body !== "object") return;
    const b = body as Record<string, unknown>;
    const persistedId = persistedIdOf(b);
    let document = typeof b.query === "string" ? b.query : undefined;
    if (persistedId && document) learned.set(persistedId, document);
    if (!document && persistedId) document = manifest?.get(persistedId) ?? learned.get(persistedId);
    if (!document && !persistedId) return;
    out.push({ document, persistedId, operationName: (b.operationName as string | null) ?? null, variables: (b.variables as Record<string, unknown> | null) ?? null });
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
 * Record every GraphQL request the page (or context) sends. Call once per test, typically in a fixture:
 *
 *   test.beforeEach(async ({ page }, testInfo) => { await captureGraphQL(page, { source: testInfo.title }); });
 */
export async function captureGraphQL(target: Page | BrowserContext, options: PlaywrightCaptureOptions = {}): Promise<void> {
  const endpoint = options.endpoint ?? "/graphql";
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  const matches = (url: string) => (typeof endpoint === "string" ? url.includes(endpoint) : endpoint.test(url));
  const manifestFiles = options.manifest === undefined ? [] : Array.isArray(options.manifest) ? options.manifest : [options.manifest];
  const manifest = manifestFiles.length ? mergePersistedManifests(manifestFiles.map((f) => parsePersistedManifest(readFileSync(f, "utf8")))) : undefined;
  target.on("request", (request) => {
    if (!matches(request.url())) return;
    for (const op of operationsFromRequest(request, manifest)) {
      try {
        writeCapture(dir, { ...op, source: options.source });
      } catch {
        // ignore
      }
    }
  });
}
