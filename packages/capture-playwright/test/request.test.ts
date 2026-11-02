import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Request } from "@playwright/test";
import { readCaptures } from "@gqlcov/core";
import { captureGraphQL, operationsFromRequest, persistedIdOf } from "../src/index.js";

const post = (body: unknown): Request => ({ method: () => "POST", url: () => "http://x/graphql", postData: () => JSON.stringify(body) }) as unknown as Request;
const get = (params: Record<string, string>): Request => ({ method: () => "GET", url: () => `http://x/graphql?${new URLSearchParams(params)}`, postData: () => null }) as unknown as Request;

describe("operationsFromRequest", () => {
  it("records the persisted id when only a hash is sent, and resolves it from a manifest", () => {
    const body = { operationName: "A", variables: { x: 1 }, extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } } };
    expect(operationsFromRequest(post(body))).toEqual([{ document: undefined, persistedId: "abc", operationName: "A", variables: { x: 1 } }]);
    expect(operationsFromRequest(post(body), new Map([["abc", "{ a }"]]))[0].document).toBe("{ a }");
  });

  it("learns the document from an APQ cache miss and reuses it for later hash-only requests", () => {
    const ext = { persistedQuery: { version: 1, sha256Hash: "learn-me" } };
    operationsFromRequest(post({ query: "{ b }", extensions: ext }));
    expect(operationsFromRequest(post({ extensions: ext }))[0].document).toBe("{ b }");
  });

  it("understands documentId, Relay doc_id and GET requests", () => {
    expect(persistedIdOf({ documentId: "d1" })).toBe("d1");
    expect(persistedIdOf({ doc_id: "r1" })).toBe("r1");
    expect(persistedIdOf({ query: "{ a }" })).toBeUndefined();
    const ops = operationsFromRequest(get({ doc_id: "r1", variables: '{"v":2}' }));
    expect(ops).toEqual([{ document: undefined, persistedId: "r1", operationName: null, variables: { v: 2 } }]);
    expect(operationsFromRequest(get({ query: "{ a }", extensions: '{"persistedQuery":{"sha256Hash":"g1"}}' }))[0]).toMatchObject({ document: "{ a }", persistedId: "g1" });
  });

  it("still handles batches and ignores bodies with neither query nor id", () => {
    expect(operationsFromRequest(post([{ query: "{ a }" }, { query: "{ b }" }]))).toHaveLength(2);
    expect(operationsFromRequest(post({ variables: {} }))).toEqual([]);
  });
});

describe("captureGraphQL", () => {
  type Listener = (r: Request) => void;
  const fakeTarget = () => {
    let listener: Listener | undefined;
    const target = { on: (event: string, cb: Listener) => { if (event === "request") listener = cb; } };
    return { target: target as unknown as Page, send: (r: Request) => listener!(r) };
  };
  const at = (url: string, body: unknown): Request => ({ method: () => "POST", url: () => url, postData: () => JSON.stringify(body) }) as unknown as Request;

  it("writes a capture per matching request, labelled with the source, resolving ids from manifests", async () => {
    const root = mkdtempSync(join(tmpdir(), "gqlcov-pw-"));
    const dir = join(root, "captures");
    const apollo = join(root, "apollo.json");
    const relay = join(root, "relay.json");
    writeFileSync(apollo, JSON.stringify({ format: "apollo-persisted-query-manifest", version: 1, operations: [{ id: "a1", body: "{ a }" }] }));
    writeFileSync(relay, JSON.stringify({ r1: "{ r }" }));
    const { target, send } = fakeTarget();
    await captureGraphQL(target, { dir, source: "my test", manifest: [apollo, relay] });
    send(at("http://app/graphql", { query: "{ x }" }));
    send(at("http://app/graphql", { extensions: { persistedQuery: { sha256Hash: "a1" } } }));
    send(at("http://app/graphql", { doc_id: "r1" }));
    send(at("http://app/rest", { query: "{ ignored }" }));
    const ops = readCaptures(dir);
    expect(ops.map((o) => o.document).sort()).toEqual(["{ a }", "{ r }", "{ x }"]);
    expect(ops.every((o) => o.source === "my test")).toBe(true);
  });

  it("matches a RegExp endpoint, reads one manifest path, and falls back to the env folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "gqlcov-pw-"));
    const manifest = join(root, "m.json");
    writeFileSync(manifest, JSON.stringify([{ id: "m", body: "{ m }" }]));
    const prev = process.env.GQLCOV_CAPTURE_DIR;
    process.env.GQLCOV_CAPTURE_DIR = join(root, "env");
    try {
      const { target, send } = fakeTarget();
      await captureGraphQL(target, { endpoint: /\/api\/gql$/, manifest });
      send(at("http://app/api/gql", { documentId: "m" }));
      send(at("http://app/graphql", { query: "{ no }" }));
      expect(readCaptures(join(root, "env")).map((o) => o.document)).toEqual(["{ m }"]);
    } finally {
      if (prev === undefined) delete process.env.GQLCOV_CAPTURE_DIR;
      else process.env.GQLCOV_CAPTURE_DIR = prev;
    }
  });

  it("uses the default endpoint and folder, and never throws when a capture cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "gqlcov-pw-"));
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    const { target, send } = fakeTarget();
    await captureGraphQL(target, { dir: join(blocker, "captures") });
    expect(() => send(at("http://app/graphql", { query: "{ x }" }))).not.toThrow();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const d = fakeTarget();
      await captureGraphQL(d.target);
      d.send(at("http://app/graphql", { query: "{ y }" }));
      expect(readCaptures(join(root, ".gqlcov/captures")).map((o) => o.document)).toEqual(["{ y }"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("skips empty bodies, non-JSON bodies, junk batch entries and unparsable GET parameters", () => {
    const raw = (postData: string | null): Request => ({ method: () => "POST", url: () => "http://x/graphql", postData: () => postData }) as unknown as Request;
    expect(operationsFromRequest(raw(null))).toEqual([]);
    expect(operationsFromRequest(raw("--multipart--"))).toEqual([]);
    expect(operationsFromRequest(post([null, 3, { query: "{ a }" }]))).toHaveLength(1);
    expect(operationsFromRequest(get({ query: "{ a }", variables: "{not json" }))[0].variables).toBeNull();
  });
});
