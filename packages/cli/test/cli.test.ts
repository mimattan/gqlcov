import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql";
import { writeCapture, type CoverageReport } from "@gqlcov/core";
import { buildCli } from "../src/index.js";
import { fmtRequests } from "../src/format.js";

const sdl = /* GraphQL */ `
enum Surface { CLAY HARD }
enum Status { OPEN CLOSED }
input CourtFilter { surface: Surface, indoor: Boolean, legacy: String @deprecated(reason: "x") }
type Court { id: ID!, status: Status!, surface: Surface }
type Club { id: ID!, name: String!, courts(filter: CourtFilter): [Court!]! }
type Query { clubs: [Club!]!, club(id: ID!): Club }
type Mutation { renameClub(id: ID!, name: String!): Club! }
`;
const clubsSdl = `enum Surface { CLAY HARD } input CourtFilter { surface: Surface, indoor: Boolean } type Club { id: ID!, name: String!, courts(filter: CourtFilter): [Court!]! } type Court { id: ID! } type Query { clubs: [Club!]!, club(id: ID!): Club } type Mutation { renameClub(id: ID!, name: String!): Club! }`;
const courtsSdl = `enum Status { OPEN CLOSED } enum Surface { CLAY HARD } type Court { id: ID!, status: Status!, surface: Surface }`;

let root: string;
let server: Server;
let base: string;
const at = (...p: string[]) => join(root, ...p);

/** A local stand-in for a GraphQL endpoint, GraphOS and the Cosmo Platform API. */
function startServer(): Promise<void> {
  const schema = buildSchema(sdl);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const json = body ? JSON.parse(body) : {};
      if (req.url === "/graphql") {
        if (req.headers.authorization !== "Bearer t") return send(401, { errors: [{ message: "unauthorised" }] });
        return send(200, graphqlSync({ schema, source: json.query }));
      }
      if (req.url === "/no-introspection") return send(200, { errors: [{ message: "introspection is disabled" }] });
      if (req.url === "/apollo") {
        if (json.query.includes("GqlcovFieldUsage"))
          return send(200, { data: { graph: { variant: { schemaCoordinateInsightsUsageReport: { records: [{ namedType: "Query", namedAttribute: "clubs", referencingOperationCount: 120000, estimatedExecutionCount: 9, used: true }] } } } } });
        return send(200, { data: { graph: { variants: [{ name: "current" }], variant: { latestApprovedLaunch: null, latestPublication: { schema: { document: sdl } } } } } });
      }
      const method = req.url!.split("/").pop();
      if (method === "GetFederatedGraphSDLByName") return send(200, { response: { code: "OK" }, sdl });
      if (method === "GetFederatedGraphByName") return send(200, { response: { code: "OK" }, subgraphs: [{ name: "clubs" }, { name: "courts" }] });
      if (method === "GetSubgraphSDLFromLatestComposition") return send(200, { response: { code: "OK" }, sdl: json.name === "clubs" ? clubsSdl : courtsSdl });
      if (method === "GetGraphFieldUsage") return send(200, { response: { code: "OK" }, fields: [{ typeName: "Club", fieldName: "name", requestCount: "40" }], dateRange: { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" } });
      send(404, { message: "unknown route" });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    r();
  }));
}

const saved = { ...process.env };
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "gqlcov-cli-"));
  writeFileSync(at("schema.graphql"), sdl);
  writeFileSync(at("clubs.graphql"), clubsSdl);
  writeFileSync(at("courts.graphql"), courtsSdl);
  writeFileSync(at("introspection.json"), JSON.stringify(graphqlSync({ schema: buildSchema(sdl), source: getIntrospectionQuery() })));
  const caps = at("captures");
  writeCapture(caps, { document: `query Clubs { clubs { id name courts(filter: { surface: CLAY }) { id status } } }`, responseEnums: { Status: ["OPEN"] } });
  writeCapture(caps, { document: `mutation Rename { renameClub(id: "1", name: "x") { id } }` });
  writeCapture(caps, { document: `{ nope }` });
  writeCapture(caps, { persistedId: "p1" });
  writeCapture(caps, { persistedId: "p2" });
  writeFileSync(at("manifest.json"), JSON.stringify({ p1: `query Club { club(id: "1") { name } }` }));
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Gone.f${i}`, i + 1]));
  writeFileSync(at("usage.json"), JSON.stringify({ source: "hand-made", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z", fields: { ...many, "Court.surface": 2_500_000, "Query.clubs": 3 } }));
  writeFileSync(at("usage-many.json"), JSON.stringify(Object.fromEntries(["Query.club", "Mutation.renameClub", "Court.surface", "Court.status", "Club.name", "Club.id", "Club.courts", "Court.id", "Query.clubs"].flatMap((f, i) => Array.from({ length: 4 }, (_, j) => [`${f}${j ? `x${j}` : ""}`, i + j + 1])))));
  await startServer();
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  process.exitCode = undefined;
  for (const k of ["APOLLO_KEY", "APOLLO_REGISTRY_URL", "COSMO_API_KEY", "COSMO_API_URL", "GITHUB_SHA", "GITHUB_REF_NAME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Run the CLI in-process and collect what it prints. */
async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    await buildCli().parseAsync(["node", "gqlcov", ...args]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join("\n"), err: err.join("\n"), code };
}
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as CoverageReport;

describe("gqlcov report", () => {
  it("writes every output and prints the summary, subgraphs, usage, untested list and unresolved ids", async () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "feature";
    const r = await cli("report", "-s", at("schema.graphql"), "-c", at("captures"), "-o", at("full", "report.json"), "--html", at("full", "report.html"),
      "--lcov", at("full", "lcov.info"), "--istanbul", at("full", "coverage.json"), "--subgraph", `clubs=${at("clubs.graphql")}`, `courts=${at("courts.graphql")}`,
      "--usage", at("usage.json"), "--persisted", at("manifest.json"), "--untested", "--include-deprecated", "--exclude", "Mutation.*");
    expect(r.out).toContain("gqlcov: 3 operations (2 queries, 1 mutations, 0 subscriptions, 1 invalid, 1 unresolved persisted ids)");
    expect(r.out).toMatch(/clubs\s+\d+(\.\d+)?% \(\d+\/\d+\)/);
    expect(r.out).toContain("production usage (hand-made, 2026-10-01 to 2026-10-31)");
    expect(r.out).toMatch(/Court\.surface\s+2\.5M requests/);
    expect(r.out).toMatch(/in usage but not in the schema \(30\): .*, \.\.\./);
    expect(r.out).toContain("1 captures carried only a persisted id");
    expect(r.out).toMatch(/\n  fields \(\d+\):\n    /);
    const report = readJson(at("full", "report.json"));
    expect(report.run).toMatchObject({ sha: "abc123", branch: "feature" });
    expect(report.inputTypes.CourtFilter.fields.legacy).toBeDefined(); // --include-deprecated
    expect(report.types.Mutation.fields.renameClub).toBeUndefined(); // --exclude
    expect(Object.keys(report.subgraphs!)).toEqual(["clubs", "courts"]);
    expect(readFileSync(at("full", "lcov.info"), "utf8")).toContain(`SF:${at("schema.graphql")}`);
    expect(JSON.parse(readFileSync(at("full", "coverage.json"), "utf8"))[at("schema.graphql")]).toBeDefined();
    expect(readFileSync(at("full", "report.html"), "utf8")).toContain("Production usage");
  });

  it("prints a short summary without usage or subgraphs, and says when no captures were found", async () => {
    const r = await cli("report", "-s", at("schema.graphql"), "-c", at("empty"), "-o", at("short", "report.json"));
    expect(r.out).toContain("gqlcov: 0 operations (0 queries, 0 mutations, 0 subscriptions), schema");
    expect(r.out).toContain(`(no captures found in ${at("empty")})`);
    expect(r.out).not.toContain("production usage");
    expect(r.out).not.toContain("Subgraph");
    expect(r.out).toContain(`report: ${at("short", "report.json")}\n`.trim());
  });

  it("is quiet with -q and prints a usage list without a window or unknown fields", async () => {
    expect((await cli("report", "-q", "-s", at("schema.graphql"), "-c", at("captures"), "-o", at("quiet", "report.json"))).out).toBe("");
    writeFileSync(at("usage-plain.json"), JSON.stringify({ "Query.clubs": 1 }));
    const r = await cli("report", "-s", at("schema.graphql"), "-c", at("captures"), "-o", at("plain", "report.json"), "--usage", at("usage-plain.json"));
    expect(r.out).toContain("\n  production usage: 1 fields with traffic, 1 tested,");
    expect(r.out).not.toContain("never tested");
    expect(r.out).not.toContain("not in the schema");
  });

  it("writes the SDL next to LCOV when the schema came from introspection JSON", async () => {
    await cli("report", "-q", "-s", at("introspection.json"), "-c", at("captures"), "-o", at("intro", "report.json"), "--lcov", at("intro", "lcov.info"), "--schema-out", at("intro", "schema.graphql"));
    expect(readFileSync(at("intro", "lcov.info"), "utf8")).toContain(`SF:${at("intro", "schema.graphql")}`);
    expect(readFileSync(at("intro", "schema.graphql"), "utf8")).toContain("type Club");
  });

  it("introspects an endpoint with headers, and explains when it cannot", async () => {
    const r = await cli("report", "-s", `${base}/graphql`, "-H", "Authorization: Bearer t", "-c", at("captures"), "-o", at("endpoint", "report.json"), "--istanbul", at("endpoint", "c.json"), "--schema-out", at("endpoint", "schema.graphql"));
    expect(r.out).toContain(`gqlcov: schema from ${base}/graphql\n`);
    expect(existsSync(at("endpoint", "schema.graphql"))).toBe(true);
    await expect(cli("report", "-s", `${base}/graphql`, "-o", at("x.json"))).rejects.toThrow("Introspection failed: 401 Unauthorized");
    await expect(cli("report", "-s", `${base}/no-introspection`, "-o", at("x.json"))).rejects.toThrow("Introspection errors: introspection is disabled");
  });

  it("loads the schema from GraphOS and from Cosmo, with Cosmo's subgraphs", async () => {
    Object.assign(process.env, { APOLLO_KEY: "k", APOLLO_REGISTRY_URL: `${base}/apollo`, COSMO_API_KEY: "k", COSMO_API_URL: `${base}/cosmo` });
    const apollo = await cli("report", "-s", "apollo:club@current", "-c", at("captures"), "-o", at("apollo", "report.json"));
    expect(apollo.out).toContain("gqlcov: schema from GraphOS schema club@current\n");
    const cosmo = await cli("report", "-s", "cosmo:default/club", "-c", at("captures"), "-o", at("cosmo", "report.json"), "--lcov", at("cosmo", "lcov.info"), "--schema-out", at("cosmo", "schema.graphql"));
    expect(cosmo.out).toContain("gqlcov: schema from Cosmo federated graph default/club, 2 subgraphs");
    expect(Object.keys(readJson(at("cosmo", "report.json")).subgraphs!)).toEqual(["clubs", "courts"]);
    const explicit = await cli("report", "-s", "cosmo:club", "-c", at("captures"), "-o", at("cosmo2", "report.json"), "--subgraph", `only=${at("clubs.graphql")}`);
    expect(explicit.out).toMatch(/only\s+/);
  });

  it("shortens a long list of used but untested fields", async () => {
    writeFileSync(at("wide.graphql"), `type Query { ${Array.from({ length: 30 }, (_, i) => `f${i}: Int`).join(" ")} }`);
    writeFileSync(at("usage-wide.json"), JSON.stringify({ ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Query.f${i}`, 100 - i])), "Query.removed": 4 }));
    const r = await cli("report", "-s", at("wide.graphql"), "-c", at("empty"), "-o", at("wide", "report.json"), "--usage", at("usage-wide.json"));
    expect(r.out).toContain("used in production, never tested (30):");
    expect(r.out).toContain("    ... and 5 more");
    expect(r.out).toContain("  in usage but not in the schema (1): Query.removed\n");
  });

  it("rejects a malformed --subgraph", async () => {
    await expect(cli("report", "-s", at("schema.graphql"), "-o", at("bad.json"), "--subgraph", "nofile")).rejects.toThrow('--subgraph expects name=path, got "nofile"');
  });
});

describe("gqlcov usage", () => {
  it("writes GraphOS and Cosmo usage files", async () => {
    Object.assign(process.env, { APOLLO_KEY: "k", APOLLO_REGISTRY_URL: `${base}/apollo`, COSMO_API_KEY: "k", COSMO_API_URL: `${base}/cosmo` });
    const a = await cli("usage", "apollo", "club@current", "-o", at("u", "apollo.json"), "--metric", "executions", "--limit", "10", "--since", "2026-10-01T00:00:00Z");
    expect(a.out).toMatch(/^gqlcov: 1 fields from apollo club@current \(estimated executions\), 2026-10-01 to \d{4}-\d\d-\d\d: /);
    expect(JSON.parse(readFileSync(at("u", "apollo.json"), "utf8")).fields).toEqual({ "Query.clubs": 9 });
    const c = await cli("usage", "cosmo", "club", "-o", at("u", "cosmo.json"), "--range", "48");
    expect(c.out).toContain("gqlcov: 1 fields from cosmo default/club (requests), 2026-10-01 to 2026-10-31");
    await cli("usage", "cosmo", "club", "-o", at("u", "cosmo2.json"), "--from", "2026-10-01T00:00:00Z", "--to", "2026-10-31T00:00:00Z");
    expect(JSON.parse(readFileSync(at("u", "cosmo2.json"), "utf8")).fields).toEqual({ "Club.name": 40 });
  });

  it("rejects an unknown metric", async () => {
    await expect(cli("usage", "apollo", "club", "--metric", "latency")).rejects.toThrow("--metric must be requests or executions");
  });
});

describe("gqlcov merge, diff and gate", () => {
  let fullPath: string;
  let shortPath: string;
  beforeAll(async () => {
    const subs = ["--subgraph", `clubs=${at("clubs.graphql")}`, `courts=${at("courts.graphql")}`];
    await cli("report", "-q", "-s", at("schema.graphql"), "-c", at("captures"), "-o", (fullPath = at("g", "full.json")), "--usage", at("usage-many.json"), ...subs);
    await cli("report", "-q", "-s", at("schema.graphql"), "-c", at("empty"), "-o", (shortPath = at("g", "empty.json")), ...subs);
  });

  it("merges shards", async () => {
    const r = await cli("merge", fullPath, shortPath, "-o", at("g", "merged.json"));
    expect(r.out).toContain("gqlcov: 2 operations");
    expect(readJson(at("g", "merged.json")).operations.total).toBe(2);
  });

  it("diffs as text with per-subgraph deltas, and as JSON", async () => {
    const r = await cli("diff", fullPath, shortPath);
    expect(r.out).toMatch(/fields\s+\d+(\.\d+)?% -> 0% \(-[\d.]+\)/);
    expect(r.out).toContain("subgraph clubs");
    expect(r.out).toContain("lost coverage (");
    const back = await cli("diff", shortPath, fullPath);
    expect(back.out).toMatch(/\(\+[\d.]+\)/);
    expect(back.out).toContain("newly covered (");
    const json = await cli("diff", fullPath, shortPath, "--json");
    expect(JSON.parse(json.out).lostCoverage.length).toBeGreaterThan(0);
    const other = await cli("report", "-q", "-s", at("clubs.graphql"), "-c", at("empty"), "-o", at("g", "other.json"));
    expect(other.out).toBe("");
    const schemaChange = await cli("diff", fullPath, at("g", "other.json"));
    expect(schemaChange.out).toContain("removed from schema (");
    expect((await cli("diff", at("g", "other.json"), fullPath)).out).toContain("added to schema (");
  });

  it("passes and fails the gate with every threshold", async () => {
    expect(await cli("gate", fullPath, "--min-fields", "1")).toMatchObject({ code: 0 });
    const fail = await cli("gate", shortPath, "--min-fields", "10", "--min-input-fields", "10", "--min-enum-values", "10", "--base", fullPath, "--tolerance", "0.5", "--subgraph", "clubs", "--min-used-fields", "1");
    expect(fail.code).toBe(1);
    expect(fail.out).toContain("gqlcov: 0 operations"); // the summary goes to stdout, failures to stderr
    expect(fail.err).toContain("gate: FAILED");
    expect(fail.err).toContain("[clubs] field coverage 0% is below the minimum 10%");
    expect(fail.err).toContain("--min-used-fields needs production usage");
    const used = await cli("gate", fullPath, "--min-used-fields", "99");
    expect(used.err).toMatch(/of fields with production traffic are tested/);
    expect((await cli("gate", fullPath)).out).toContain("gate: passed");
  });

  it("prints older reports without the observed or usage numbers", async () => {
    const legacy = readJson(fullPath) as unknown as Record<string, Record<string, unknown>>;
    delete legacy.summary.enumValuesObserved;
    delete legacy.usage;
    writeFileSync(at("g", "legacy.json"), JSON.stringify(legacy));
    const r = await cli("gate", at("g", "legacy.json"));
    expect(r.out).not.toContain("Enum values in responses");
    expect(r.out).not.toContain("Production fields tested");
  });
});

describe("request counts", () => {
  it("formats plain numbers, thousands and millions", () => {
    expect([fmtRequests(950), fmtRequests(9999), fmtRequests(15_400), fmtRequests(2_460_000)]).toEqual(["950", "9999", "15k", "2.5M"]);
  });
});
