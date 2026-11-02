import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApolloServer } from "@apollo/server";
import { buildSchema, parse } from "graphql";
import { readCaptures } from "@gqlcov/core";
import { gqlcovCapturePlugin, type CaptureOptions } from "../src/index.js";

const typeDefs = `enum Status { OPEN CLOSED } type Court { id: ID!, status: Status! } type Query { court(id: ID!): Court, boom: Int! }`;
const resolvers = { Query: { court: (_: unknown, { id }: { id: string }) => ({ id, status: "OPEN" }), boom: () => { throw new Error("boom"); } } };

async function run(options: CaptureOptions, query: string, variables?: Record<string, unknown>, operationName?: string, contextValue: Record<string, unknown> = {}) {
  const server = new ApolloServer<Record<string, unknown>>({ typeDefs, resolvers, plugins: [gqlcovCapturePlugin(options)] });
  await server.start();
  try {
    return await server.executeOperation({ query, variables, operationName }, { contextValue });
  } finally {
    await server.stop();
  }
}

const env = { capture: process.env.GQLCOV_CAPTURE, node: process.env.NODE_ENV, dir: process.env.GQLCOV_CAPTURE_DIR };
afterEach(() => {
  for (const [k, v] of [["GQLCOV_CAPTURE", env.capture], ["NODE_ENV", env.node], ["GQLCOV_CAPTURE_DIR", env.dir]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
const fresh = () => join(mkdtempSync(join(tmpdir(), "gqlcov-apollo-")), "captures");

describe("gqlcovCapturePlugin", () => {
  it("captures document, operation, variables, source and response enums", async () => {
    const dir = fresh();
    await run({ dir, enabled: true, source: (ctx) => ctx.who as string }, `query Q($id: ID!) { court(id: $id) { status } }`, { id: "1" }, "Q", { who: "test a" });
    const [op] = readCaptures(dir);
    expect(op).toMatchObject({ operationName: "Q", variables: { id: "1" }, source: "test a", responseEnums: { Status: ["OPEN"] } });
  });

  it("captures operations without a name, variables or data, and skips documents that never resolved", async () => {
    const dir = fresh();
    await run({ dir, enabled: true }, `{ boom }`);
    await run({ dir, enabled: true }, `{ nope }`); // fails validation: no operation to record
    await run({ dir, enabled: true }, `{ broken`); // fails parsing
    const ops = readCaptures(dir);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operationName: null, variables: null });
    expect(ops[0].responseEnums).toBeUndefined();
  });

  it("is off when disabled, and follows a function, GQLCOV_CAPTURE and NODE_ENV", async () => {
    const dir = fresh();
    await run({ dir, enabled: false }, `{ boom }`);
    await run({ dir, enabled: () => false }, `{ boom }`);
    delete process.env.GQLCOV_CAPTURE;
    process.env.NODE_ENV = "production";
    await run({ dir }, `{ boom }`);
    expect(readCaptures(dir)).toHaveLength(0);
    await run({ dir, enabled: () => true }, `{ boom }`);
    process.env.GQLCOV_CAPTURE = "1";
    await run({ dir }, `{ boom }`);
    delete process.env.GQLCOV_CAPTURE;
    process.env.NODE_ENV = "test";
    await run({ dir }, `{ boom }`);
    expect(readCaptures(dir)).toHaveLength(3);
  });

  it("writes to GQLCOV_CAPTURE_DIR by default and never breaks a request it cannot record", async () => {
    const root = mkdtempSync(join(tmpdir(), "gqlcov-apollo-"));
    process.env.GQLCOV_CAPTURE_DIR = join(root, "env");
    await run({ enabled: true }, `{ boom }`);
    expect(readCaptures(join(root, "env"))).toHaveLength(1);
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    const res = await run({ dir: join(blocker, "captures"), enabled: true }, `{ court(id: "1") { id } }`);
    expect(res.body.kind === "single" && res.body.singleResult.data).toEqual({ court: { id: "1" } });
  });

  it("walks the initial payload of incremental responses and tolerates one it cannot walk", async () => {
    const dir = fresh();
    const schema = buildSchema(typeDefs);
    const document = parse(`{ court(id: "1") { status } }`);
    const call = async (ctxSchema: unknown) => {
      const hooks = (await gqlcovCapturePlugin({ dir, enabled: true }).requestDidStart!({} as never)) as Record<string, (ctx: unknown) => Promise<void>>;
      await hooks.didResolveOperation({ document, operationName: null, request: {}, contextValue: {} });
      await hooks.willSendResponse({ document, schema: ctxSchema, operationName: null, response: { body: { kind: "incremental", initialResult: { data: { court: { status: "CLOSED" } } } } } });
    };
    await call(schema);
    await call({});
    const ops = readCaptures(dir);
    expect(ops.map((o) => o.responseEnums)).toContainEqual({ Status: ["CLOSED"] });
    expect(ops.filter((o) => o.responseEnums === undefined)).toHaveLength(1);
  });

  it("falls back to .gqlcov/captures in the working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "gqlcov-default-"));
    delete process.env.GQLCOV_CAPTURE_DIR;
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run({ enabled: true }, `{ boom }`);
    } finally {
      process.chdir(cwd);
    }
    expect(readCaptures(join(root, ".gqlcov/captures"))).toHaveLength(1);
  });
});
