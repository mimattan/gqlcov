import { describe, expect, it } from "vitest";
import { applyUsage, computeCoverage, gate, mergeReports, parseUsage } from "../src/index.js";

const sdl = /* GraphQL */ `
  type Player { id: ID!, name: String!, rating: Float }
  type Query { player(id: ID!): Player, players: [Player!]!, legacy: Int }
`;
const ops = [{ document: `{ players { id name } }` }];

describe("production usage join", () => {
  it("parses the wrapped and the bare format", () => {
    expect(parseUsage(`{"fields":{"Query.players":5},"source":"x"}`)).toEqual({ fields: { "Query.players": 5 }, source: "x" });
    expect(parseUsage({ "Query.players": 5, "Query.player": 0 })).toEqual({ fields: { "Query.players": 5, "Query.player": 0 } });
  });

  it("splits fields into used+untested, tested+unused and neither", () => {
    const r = computeCoverage(sdl, ops, { usage: { fields: { "Query.players": 900, "Query.player": 100, "Player.id": 1000, "Player.rating": 40, "Query.removed": 3, "Query.legacy": 0 }, source: "apollo g@current", from: "2026-10-01T00:00:00Z" } });
    expect(r.types.Query.fields.player.requests).toBe(100);
    expect(r.types.Query.fields.legacy.requests).toBe(0);
    expect(r.usage).toMatchObject({ source: "apollo g@current", from: "2026-10-01T00:00:00Z", usedFields: { covered: 2, total: 4, percent: 50 } });
    expect(r.usage!.untestedUsed).toEqual([{ path: "Query.player", requests: 100 }, { path: "Player.rating", requests: 40 }]);
    expect(r.usage!.testedUnused).toEqual(["Player.name"]);
    expect(r.usage!.unusedUntested).toEqual(["Query.legacy"]);
    expect(r.usage!.unknown).toEqual(["Query.removed"]);
  });

  it("gates on the tested share of used fields", () => {
    const r = computeCoverage(sdl, ops, { usage: { fields: { "Query.players": 900, "Query.player": 100 } } });
    expect(gate(r, { minUsedFields: 50 }).passed).toBe(true);
    const g = gate(r, { minUsedFields: 90 });
    expect(g.failures[0]).toMatch(/^50% of fields with production traffic are tested, below the minimum 90% \(1 untested: Query.player\)/);
    expect(gate(computeCoverage(sdl, ops), { minUsedFields: 1 }).failures[0]).toMatch(/needs production usage/);
  });

  it("re-applies cleanly and survives a merge", () => {
    const r = computeCoverage(sdl, ops);
    applyUsage(r, { fields: { "Query.player": 1 } });
    applyUsage(r, { fields: { "Query.players": 1 } });
    expect(r.types.Query.fields.player.requests).toBeUndefined();
    const other = computeCoverage(sdl, [{ document: `{ player(id: "1") { id } }` }]);
    const m = mergeReports([r, other]);
    expect(m.usage!.usedFields).toMatchObject({ covered: 1, total: 1 });
    expect(m.types.Query.fields.players.requests).toBe(1);
  });

  it("handles no traffic at all, malformed paths and ties", () => {
    const quiet = computeCoverage(sdl, ops, { usage: { fields: { weird: 4, "Query.legacy": 0 }, to: "2026-11-01T00:00:00Z" } });
    expect(quiet.usage).toMatchObject({ usedFields: { covered: 0, total: 0, percent: 100 }, unknown: ["weird"], to: "2026-11-01T00:00:00Z" });
    const tie = computeCoverage(sdl, ops, { usage: { fields: { "Query.player": 5, "Player.rating": 5 } } });
    expect(tie.usage!.untestedUsed.map((x) => x.path)).toEqual(["Player.rating", "Query.player"]);
  });
});
