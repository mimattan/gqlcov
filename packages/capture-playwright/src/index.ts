import type { BrowserContext, Page, Request } from "@playwright/test";
import { DEFAULT_CAPTURE_DIR, writeCapture, type CapturedOperation } from "@gqlcov/core";

export interface PlaywrightCaptureOptions {
  /** Match the GraphQL endpoint. String = substring of the URL; RegExp = test against the URL. Default "/graphql". */
  endpoint?: string | RegExp;
  dir?: string;
  /** Label written as `source`, e.g. `testInfo.titlePath.join(" > ")`. */
  source?: string;
}

/** Parse one HTTP request body into zero or more operations (handles batched arrays and GET persisted-style queries). */
export function operationsFromRequest(request: Request): CapturedOperation[] {
  const out: CapturedOperation[] = [];
  const push = (body: unknown) => {
    if (!body || typeof body !== "object") return;
    const b = body as Record<string, unknown>;
    if (typeof b.query !== "string") return;
    out.push({ document: b.query, operationName: (b.operationName as string | null) ?? null, variables: (b.variables as Record<string, unknown> | null) ?? null });
  };
  if (request.method() === "GET") {
    const url = new URL(request.url());
    const q = url.searchParams.get("query");
    if (q) {
      let variables: Record<string, unknown> | null = null;
      try { variables = JSON.parse(url.searchParams.get("variables") ?? "null"); } catch { /* ignore */ }
      push({ query: q, operationName: url.searchParams.get("operationName"), variables });
    }
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
  target.on("request", (request) => {
    if (!matches(request.url())) return;
    for (const op of operationsFromRequest(request)) {
      try {
        writeCapture(dir, { ...op, source: options.source });
      } catch {
        // ignore
      }
    }
  });
}
