import { describe, expect, it } from "vitest";
import type { Request } from "@playwright/test";
import { operationsFromRequest, persistedIdOf } from "../src/index.js";

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
