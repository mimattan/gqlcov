import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelop, useEngine, useSchema } from "@envelop/core";
import { buildSchema, execute, parse, specifiedRules, subscribe, validate } from "graphql";
import { readCaptures } from "@gqlcov/core";
import { useGqlcovCapture, type CaptureOptions } from "../src/index.js";

const schema = buildSchema(`enum Status { OPEN CLOSED } type Court { id: ID!, status: Status! } type Query { court(id: ID!): Court, boom: Int! }`);
const rootValue = { court: ({ id }: { id: string }) => ({ id, status: "OPEN" }), boom: () => { throw new Error("boom"); } };

async function run(options: CaptureOptions, query: string, variables?: Record<string, unknown>, operationName?: string, context: Record<string, unknown> = {}) {
  const getEnveloped = envelop({ plugins: [useEngine({ parse, validate, execute, subscribe, specifiedRules }), useSchema(schema), useGqlcovCapture(options)] });
  const e = getEnveloped(context);
  const document = e.parse(query);
  return e.execute({ schema: e.schema, document, rootValue, variableValues: variables, operationName, contextValue: await e.contextFactory() });
}

const env = { capture: process.env.GQLCOV_CAPTURE, node: process.env.NODE_ENV, dir: process.env.GQLCOV_CAPTURE_DIR };
afterEach(() => {
  for (const [k, v] of [["GQLCOV_CAPTURE", env.capture], ["NODE_ENV", env.node], ["GQLCOV_CAPTURE_DIR", env.dir]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
const fresh = () => join(mkdtempSync(join(tmpdir(), "gqlcov-envelop-")), "captures");

describe("useGqlcovCapture subscriptions", () => {
  const subSchema = buildSchema(`type Query { x: Int } type Subscription { tick(n: Int): Int }`);
  const subRoot = { tick: async function* () { yield { tick: 1 }; yield { tick: 2 }; } };
  async function subscribeOnce(options: CaptureOptions, query: string, variables?: Record<string, unknown>, context: Record<string, unknown> = {}) {
    const e = envelop({ plugins: [useEngine({ parse, validate, execute, subscribe, specifiedRules }), useSchema(subSchema), useGqlcovCapture(options)] })(context);
    const events: unknown[] = [];
    const stream = await e.subscribe({ schema: e.schema, document: e.parse(query), rootValue: subRoot, variableValues: variables, contextValue: await e.contextFactory() });
    for await (const v of stream as AsyncIterable<unknown>) events.push(v);
    return events;
  }

  it("captures a subscription once, when the client subscribes", async () => {
    const dir = fresh();
    const events = await subscribeOnce({ dir, enabled: true, source: (ctx) => ctx.who as string, identity: () => "guest" }, `subscription Tick($n: Int) { tick(n: $n) }`, { n: 2 }, { who: "live test" });
    expect(events).toHaveLength(2);
    const ops = readCaptures(dir);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operationName: null, variables: { n: 2 }, source: "live test", identity: "guest" });
    expect(ops[0].document).toContain("subscription Tick");
    expect(ops[0].responseEnums).toBeUndefined();
  });

  it("skips subscriptions when disabled and never breaks one it cannot record", async () => {
    const dir = fresh();
    await subscribeOnce({ dir, enabled: false }, `subscription { tick }`);
    expect(readCaptures(dir)).toHaveLength(0);
    const root = mkdtempSync(join(tmpdir(), "gqlcov-envelop-"));
    writeFileSync(join(root, "file"), "x");
    expect(await subscribeOnce({ dir: join(root, "file", "captures"), enabled: true }, `subscription { tick }`)).toHaveLength(2);
  });
});

describe("useGqlcovCapture", () => {
  it("captures document, operation, variables, source and response enums", async () => {
    const dir = fresh();
    await run({ dir, enabled: true, source: (ctx) => ctx.who as string, identity: (ctx) => ctx.role as string }, `query Q($id: ID!) { court(id: $id) { status } }`, { id: "1" }, "Q", { who: "test a", role: "admin" });
    const [op] = readCaptures(dir);
    expect(op).toMatchObject({ identity: "admin", operationName: "Q", variables: { id: "1" }, source: "test a", responseEnums: { Status: ["OPEN"] } });
    expect(op.responseValues).toEqual({ "Query.court": ["value"], "Court.status": ["value"] });
    expect(op.responseTypes).toEqual({});
    expect(op.document).toContain("court(id: $id)");
  });

  it("captures operations without a name, variables or data", async () => {
    const dir = fresh();
    await run({ dir, enabled: true }, `{ boom }`);
    const [op] = readCaptures(dir);
    expect(op).toMatchObject({ operationName: null, variables: null });
    expect(op.responseValues).toEqual({ "Query.boom": ["error"] }); // data is null, but the error says which field failed
    expect(op.responseEnums).toEqual({});
    expect(op.source).toBeUndefined();
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
    const root = mkdtempSync(join(tmpdir(), "gqlcov-envelop-"));
    process.env.GQLCOV_CAPTURE_DIR = join(root, "env");
    await run({ enabled: true }, `{ boom }`);
    expect(readCaptures(join(root, "env"))).toHaveLength(1);
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    const result = await run({ dir: join(blocker, "captures"), enabled: true }, `{ court(id: "1") { id } }`);
    expect(result).toMatchObject({ data: { court: { id: "1" } } });
  });

  it("captures streamed results without enums and tolerates a response it cannot walk", () => {
    const dir = fresh();
    const hooks = useGqlcovCapture({ dir, enabled: true, source: (ctx) => (Object.keys(ctx).length ? "had context" : "no context"), identity: (ctx) => (Object.keys(ctx).length ? "had" : "nobody") }).onExecute!({ args: { document: parse(`{ court(id: "1") { status } }`), schema, operationName: undefined, variableValues: undefined, contextValue: undefined } } as never) as { onExecuteDone: (p: { result: unknown }) => void };
    hooks.onExecuteDone({ result: { [Symbol.asyncIterator]: () => ({}) } });
    const broken = useGqlcovCapture({ dir, enabled: true }).onExecute!({ args: { document: parse(`{ court(id: "1") { status } }`), schema: {}, contextValue: {} } } as never) as { onExecuteDone: (p: { result: unknown }) => void };
    broken.onExecuteDone({ result: { data: { court: { status: "OPEN" } } } });
    const ops = readCaptures(dir);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.responseEnums === undefined)).toBe(true);
    expect(ops.map((o) => o.source)).toContain("no context");
    expect(ops.map((o) => o.identity)).toContain("nobody");
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
