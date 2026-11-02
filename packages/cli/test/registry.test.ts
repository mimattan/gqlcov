import { describe, expect, it } from "vitest";
import { fetchApolloSchema, fetchApolloUsage, fetchCosmoSchema, fetchCosmoUsage, parseCosmoRef, parseGraphRef, type FetchLike } from "../src/registry.js";

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fake(responder: (call: Call) => unknown): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const out = responder(call);
    if (out instanceof Error) return { ok: false, status: 401, statusText: "Unauthorized", text: async () => JSON.stringify({ message: out.message }) };
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(out) };
  };
  return { fetchImpl, calls };
}

describe("graph refs", () => {
  it("parses Apollo and Cosmo refs with defaults", () => {
    expect(parseGraphRef("g@prod")).toEqual({ graph: "g", variant: "prod" });
    expect(parseGraphRef("g")).toEqual({ graph: "g", variant: "current" });
    expect(() => parseGraphRef("g@")).toThrow();
    expect(parseCosmoRef("ns/g")).toEqual({ namespace: "ns", name: "g" });
    expect(parseCosmoRef("g")).toEqual({ namespace: "default", name: "g" });
  });
});

describe("Apollo GraphOS", () => {
  it("fetches the supergraph with the headers the Platform API requires", async () => {
    const f = fake(() => ({ data: { graph: { variants: [{ name: "current" }], variant: { latestApprovedLaunch: { build: { result: { __typename: "BuildSuccess", coreSchema: { coreDocument: "type Query { a: Int }" } } } }, latestPublication: null } } } }));
    const r = await fetchApolloSchema("g@current", { apiKey: "service:k", fetchImpl: f.fetchImpl, clientVersion: "1.2.3" });
    expect(r).toEqual({ sdl: "type Query { a: Int }", label: "GraphOS supergraph g@current" });
    expect(f.calls[0].url).toBe("https://api.apollographql.com/api/graphql");
    expect(f.calls[0].headers).toMatchObject({ "x-api-key": "service:k", "apollographql-client-name": "gqlcov", "apollographql-client-version": "1.2.3" });
    expect(f.calls[0].body.variables).toEqual({ graph_id: "g", variant: "current" });
  });

  it("falls back to the published schema for a monograph and explains missing variants", async () => {
    const f = fake(() => ({ data: { graph: { variants: [{ name: "main" }], variant: { latestApprovedLaunch: null, latestPublication: { schema: { document: "type Query { b: Int }" } } } } } }));
    expect((await fetchApolloSchema("g", { apiKey: "k", fetchImpl: f.fetchImpl })).label).toBe("GraphOS schema g@current");
    const none = fake(() => ({ data: { graph: { variants: [{ name: "main" }], variant: null } } }));
    await expect(fetchApolloSchema("g@prod", { apiKey: "k", fetchImpl: none.fetchImpl })).rejects.toThrow('no variant "prod" (variants: main)');
    const fail = fake(() => ({ data: { graph: { variants: [], variant: { latestApprovedLaunch: { build: { result: { __typename: "BuildFailure", errorMessages: [{ message: "boom", code: "X" }] } } }, latestPublication: null } } } }));
    await expect(fetchApolloSchema("g", { apiKey: "k", fetchImpl: fail.fetchImpl })).rejects.toThrow("failed to compose: boom");
    const denied = fake(() => new Error("bad key"));
    await expect(fetchApolloSchema("g", { apiKey: "k", fetchImpl: denied.fetchImpl })).rejects.toThrow("401 Unauthorized: bad key");
  });

  it("turns the usage report into Type.field counts", async () => {
    const f = fake(() => ({ data: { graph: { variant: { schemaCoordinateInsightsUsageReport: { records: [
      { namedType: "Query", namedAttribute: "players", referencingOperationCount: "120", estimatedExecutionCount: 130, used: true },
      { namedType: "Player", namedAttribute: "name", referencingOperationCount: 0, estimatedExecutionCount: 0, used: false },
    ] } } } } }));
    const u = await fetchApolloUsage("g@current", { apiKey: "k", fetchImpl: f.fetchImpl, since: "-86400" });
    expect(u.fields).toEqual({ "Query.players": 120, "Player.name": 0 });
    expect(u.source).toBe("apollo g@current (requests)");
    expect(new Date(u.to!).getTime() - new Date(u.from!).getTime()).toBeCloseTo(86400 * 1000, -3);
    expect(f.calls[0].body.variables).toMatchObject({ since: "-86400", limit: 20000 });
    const ex = await fetchApolloUsage("g", { apiKey: "k", fetchImpl: f.fetchImpl, metric: "executions", since: "2026-10-01T00:00:00Z" });
    expect(ex.fields["Query.players"]).toBe(130);
    expect(ex.from).toBe("2026-10-01T00:00:00Z");
  });
});

describe("Cosmo", () => {
  const sdls: Record<string, string> = { clubs: "type Query { clubs: [Club!]! } type Club { id: ID! name: String! }", players: "type Query { players: [Player!]! } type Player { id: ID! }" };
  const respond = (c: Call) => {
    const method = c.url.split("/").pop();
    switch (method) {
      case "GetFederatedGraphSDLByName": return { response: { code: "OK" }, sdl: "type Query { clubs: [Club!]! players: [Player!]! } type Club { id: ID! name: String! } type Player { id: ID! }", clientSchema: "..." };
      case "GetFederatedGraphByName": return { response: { code: "OK" }, subgraphs: [{ id: "0", name: "clubs" }, { id: "1", name: "players" }] };
      case "GetSubgraphSDLFromLatestComposition": return { response: { code: "OK" }, sdl: sdls[c.body.name as string] };
      case "GetGraphFieldUsage": return { response: { code: "OK" }, fields: [{ typeName: "Query", fieldName: "clubs", requestCount: "42", subgraphs: [] }, { typeName: "Club", fieldName: "name", requestCount: 7 }], dateRange: { start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" } };
      default: return { response: { code: "ERR_NOT_FOUND", details: method } };
    }
  };

  it("fetches the router schema and every subgraph SDL with Connect headers", async () => {
    const f = fake(respond);
    const r = await fetchCosmoSchema("prod/mygraph", { apiKey: "ck", fetchImpl: f.fetchImpl });
    expect(r.label).toBe("Cosmo federated graph prod/mygraph");
    expect(Object.keys(r.subgraphSdls!)).toEqual(["clubs", "players"]);
    expect(f.calls[0].url).toBe("https://cosmo-cp.wundergraph.com/wg.cosmo.platform.v1.PlatformService/GetFederatedGraphSDLByName");
    expect(f.calls[0].headers).toMatchObject({ authorization: "Bearer ck", "connect-protocol-version": "1" });
    expect(f.calls[0].body).toEqual({ name: "mygraph", namespace: "prod" });
    expect(f.calls[2].body).toEqual({ name: "clubs", fedGraphName: "mygraph", namespace: "prod" });
  });

  it("reports a non-OK response code", async () => {
    const f = fake(() => ({ response: { code: "ERR_NOT_FOUND", details: "no such graph" } }));
    await expect(fetchCosmoSchema("nope", { apiKey: "ck", fetchImpl: f.fetchImpl })).rejects.toThrow("Cosmo GetFederatedGraphSDLByName: ERR_NOT_FOUND: no such graph");
  });

  it("turns field usage into Type.field counts and keeps the window the server used", async () => {
    const f = fake(respond);
    const u = await fetchCosmoUsage("mygraph", { apiKey: "ck", fetchImpl: f.fetchImpl, range: 168 });
    expect(u).toEqual({ source: "cosmo default/mygraph (requests)", from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z", fields: { "Query.clubs": 42, "Club.name": 7 } });
    expect(f.calls[0].body).toEqual({ federatedGraphName: "mygraph", namespace: "default", range: 168 });
    await fetchCosmoUsage("mygraph", { apiKey: "ck", fetchImpl: f.fetchImpl, from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" });
    expect(f.calls[1].body).toEqual({ federatedGraphName: "mygraph", namespace: "default", dateRange: { start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z" } });
  });
});
