import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { computeCoverage, readCaptures } from "@gqlcov/core";
import { createApp } from "../src/server.js";

const captureDir = process.env.GQLCOV_CAPTURE_DIR ?? (process.env.GQLCOV_CAPTURE ? ".gqlcov/captures" : mkdtempSync(join(tmpdir(), "gqlcov-")));
let server: Server;
let url: string;

async function gql(testName: string, query: string, variables?: Record<string, unknown>, operationName?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-name": testName },
    body: JSON.stringify({ query, variables, operationName }),
  });
  return res.json() as Promise<{ data?: unknown; errors?: unknown[] }>;
}

beforeAll(async () => {
  server = createApp(captureDir);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}/graphql`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("club app E2E", () => {
  it("lists players of a club, filtered", async () => {
    const r = await gql("list players", `query Players($f: PlayerFilter) { players(filter: $f) { id name rating club { name } } }`, { f: { clubId: "c1", gender: "F" } });
    expect(r.errors).toBeUndefined();
  });

  it("lists all players without a filter", async () => {
    const r = await gql("list all", `query AllPlayers { players { id name } }`);
    expect(r.errors).toBeUndefined();
  });

  it("creates a match on clay and reads it back", async () => {
    const create = await gql("create match", `mutation Create($input: MatchInput!) { createMatch(input: $input) { id surface sets { games tiebreak } } }`, {
      input: { surface: "CLAY", playerIds: ["p1", "p2"], sets: [{ games: 6 }, { games: 7, tiebreak: 10 }] },
    });
    expect(create.errors).toBeUndefined();
    const id = (create.data as { createMatch: { id: string } }).createMatch.id;
    const read = await gql("read match", `query Match($id: ID!) { match(id: $id) { id status players { name } note } }`, { id });
    expect(read.errors).toBeUndefined();
  });

  it("creates a match without sets", async () => {
    const r = await gql("create match no sets", `mutation { createMatch(input: { surface: HARD, playerIds: ["p1", "p2"] }) { id } }`);
    expect(r.errors).toBeUndefined();
  });
});

describe("coverage of this run", () => {
  it("reflects what the tests above sent", () => {
    const report = computeCoverage(readFileSync(new URL("../schema.graphql", import.meta.url), "utf8"), readCaptures(captureDir));
    expect(report.operations.total).toBe(5);
    expect(report.operations.invalid).toBe(0);
    // output side
    expect(report.types.Query.fields.players.hits).toBe(2);
    expect(report.types.Query.fields.clubs.hits).toBe(0);
    expect(report.types.Mutation.fields.renamePlayer.hits).toBe(0);
    // input side: field presence and both states
    const pf = report.inputTypes.PlayerFilter.fields;
    expect(pf.clubId).toMatchObject({ sent: 1, omitted: 0 });
    expect(pf.minRating).toMatchObject({ sent: 0, omitted: 1 });
    const mi = report.inputTypes.MatchInput.fields;
    expect(mi.sets).toMatchObject({ sent: 1, omitted: 1 });
    expect(mi.note).toMatchObject({ sent: 0, omitted: 2 });
    expect(report.inputTypes.ScoreInput.fields.tiebreak).toMatchObject({ sent: 1, omitted: 1 });
    // enums and value classes
    expect(report.enums.Surface.values.CLAY.hits).toBe(1);
    expect(report.enums.Surface.values.GRASS.hits).toBe(0);
    expect(report.enums.Gender.values.F.hits).toBe(1);
    expect(mi.playerIds.values.listMany).toBe(2);
    // output-only enum: scored on what responses contained, outside the enum-values number
    expect(report.enums.MatchStatus).toMatchObject({ input: false, output: true });
    expect(report.enums.MatchStatus.values.PLAYED.observed).toBe(1);
    expect(report.enums.MatchStatus.values.SCHEDULED.observed).toBe(0);
    expect(report.enums.Surface.values.CLAY.observed).toBe(1);
    expect(report.summary.enumValues.total).toBe(7); // Surface and Gender only
    // the capture source label came through from the test header
    const sources = new Set(readCaptures(captureDir).map((c) => c.source));
    expect(sources.has("create match")).toBe(true);
  });
});
