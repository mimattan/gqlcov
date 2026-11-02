import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Request } from "@playwright/test";
import { readCaptures } from "@gqlcov/core";
import { captureGraphQL, operationFromFrame, operationsFromRequest, persistedIdOf, shapesFromResponse } from "../src/index.js";

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
    await captureGraphQL(target, { dir, source: "my test", manifest: [apollo, relay], responses: false });
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
      await captureGraphQL(target, { endpoint: /\/api\/gql$/, manifest, responses: false });
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
    await captureGraphQL(target, { dir: join(blocker, "captures"), responses: false });
    expect(() => send(at("http://app/graphql", { query: "{ x }" }))).not.toThrow();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const d = fakeTarget();
      await captureGraphQL(d.target, { responses: false });
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

describe("operationFromFrame", () => {
  it("reads graphql-ws subscribe and subscriptions-transport-ws start frames, as text or bytes", () => {
    const payload = { query: "subscription Tick { tick }", operationName: "Tick", variables: { n: 1 } };
    expect(operationFromFrame(JSON.stringify({ id: "1", type: "subscribe", payload }))).toEqual({ document: payload.query, persistedId: undefined, operationName: "Tick", variables: { n: 1 } });
    expect(operationFromFrame(Buffer.from(JSON.stringify({ id: "2", type: "start", payload: { query: "{ a }" } })))).toMatchObject({ document: "{ a }", operationName: null });
    expect(operationFromFrame(JSON.stringify({ type: "subscribe", payload: { extensions: { persistedQuery: { sha256Hash: "s1" } } } }), new Map([["s1", "subscription { s }"]]))?.document).toBe("subscription { s }");
  });

  it("ignores protocol messages, other JSON and binary noise", () => {
    expect(operationFromFrame(JSON.stringify({ type: "connection_init" }))).toBeUndefined();
    expect(operationFromFrame("null")).toBeUndefined();
    expect(operationFromFrame(JSON.stringify({ type: "subscribe" }))).toBeUndefined();
    expect(operationFromFrame(Buffer.from([0xff, 0x00]))).toBeUndefined();
  });
});

describe("captureGraphQL over WebSocket", () => {
  type Handler = (x: never) => void;
  class Emitter {
    handlers = new Map<string, Handler[]>();
    on(event: string, cb: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); return this; }
    emit(event: string, x: unknown) { for (const cb of this.handlers.get(event) ?? []) cb(x as never); }
  }
  const socket = (url: string) => Object.assign(new Emitter(), { url: () => url });
  const subscribe = (query: string) => ({ payload: JSON.stringify({ id: "1", type: "subscribe", payload: { query } }) });

  it("records operations sent over a page's sockets that match the endpoint", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "gqlcov-pw-")), "captures");
    const page = new Emitter();
    await captureGraphQL(page as unknown as Page, { dir, source: "ws test" });
    const ws = socket("ws://app/graphql");
    page.emit("websocket", ws);
    ws.emit("framesent", { payload: JSON.stringify({ type: "connection_init" }) });
    ws.emit("framesent", subscribe("subscription { a }"));
    const other = socket("ws://app/chat");
    page.emit("websocket", other);
    other.emit("framesent", subscribe("subscription { ignored }"));
    expect(readCaptures(dir).map((o) => [o.document, o.source])).toEqual([["subscription { a }", "ws test"]]);
  });

  it("watches every page of a browser context, open now or later", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "gqlcov-pw-")), "captures");
    const early = new Emitter();
    const context = Object.assign(new Emitter(), { pages: () => [early] });
    await captureGraphQL(context as unknown as Page, { dir });
    const late = new Emitter();
    context.emit("page", late);
    for (const [page, q] of [[early, "subscription { early }"], [late, "subscription { late }"]] as const) {
      const ws = socket("ws://app/graphql");
      page.emit("websocket", ws);
      ws.emit("framesent", subscribe(q));
    }
    expect(readCaptures(dir).map((o) => o.document).sort()).toEqual(["subscription { early }", "subscription { late }"]);
  });
});

describe("shapesFromResponse", () => {
  it("gives one shape per result, in request order, and none for bodies that are not results", () => {
    expect(shapesFromResponse({ data: { club: { logo: null, courts: [] } } })).toEqual([{ club: 1, "club.logo": 2, "club.courts": 8 }]);
    expect(shapesFromResponse([{ data: { a: 1 } }, { errors: [{ message: "x", path: ["b"] }], data: { b: null } }, "junk"])).toEqual([{ a: 1 }, { b: 4 }, undefined]);
    expect(shapesFromResponse({ errors: "not a list", data: null })).toEqual([{}]);
    expect(shapesFromResponse(null)).toEqual([undefined]);
    expect(shapesFromResponse({ message: "not GraphQL" })).toEqual([undefined]);
  });
});

describe("captureGraphQL with responses", () => {
  type Listener = (r: Request) => unknown;
  const target = () => {
    const on: Record<string, Listener> = {};
    return { page: { on: (event: string, cb: Listener) => { on[event] = cb; } } as unknown as Page, on };
  };
  const finished = (url: string, body: unknown, response: unknown) =>
    ({ method: () => "POST", url: () => url, postData: () => JSON.stringify(body), response: async () => (response === undefined ? null : { json: async () => { if (response instanceof Error) throw response; return response; } }) }) as unknown as Request;

  it("records each operation when its request finishes, with what the response held", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "gqlcov-pw-")), "captures");
    const { page, on } = target();
    await captureGraphQL(page, { dir, source: "t" });
    expect(on.request).toBeUndefined();
    await on.requestfinished(finished("http://app/graphql", { query: "{ club { logo } }" }, { data: { club: { logo: null } } }));
    await on.requestfinished(finished("http://app/graphql", [{ query: "{ a }" }, { query: "{ b }" }], [{ data: { a: 1 } }]));
    await on.requestfinished(finished("http://app/graphql", { query: "{ gone }" }, new Error("Target closed")));
    await on.requestfinished(finished("http://app/graphql", { query: "{ none }" }, undefined));
    await on.requestfinished(finished("http://app/rest", { query: "{ ignored }" }, { data: {} }));
    await on.requestfinished(finished("http://app/graphql", { variables: {} }, { data: {} }));
    on.requestfailed(finished("http://app/graphql", { query: "{ failed }" }, undefined));
    on.requestfailed(finished("http://app/rest", { query: "{ ignored }" }, undefined));
    const ops = readCaptures(dir).map((o) => [o.document, o.responseShape ?? null, o.source]);
    expect(ops.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["{ a }", { a: 1 }, "t"],
      ["{ b }", null, "t"],
      ["{ club { logo } }", { club: 1, "club.logo": 2 }, "t"],
      ["{ failed }", null, "t"],
      ["{ gone }", null, "t"],
      ["{ none }", null, "t"],
    ]);
  });
});
