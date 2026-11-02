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
    expect(r.usage!.untestedUsed).toEqual([{ path: "Query.player", requests: 100, kind: "field" }, { path: "Player.rating", requests: 40, kind: "field" }]);
    expect(r.usage!.usedInputs).toBeUndefined(); // no input paths in the usage data
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

  describe("input fields and enum values", () => {
    const isdl = /* GraphQL */ `
      enum Surface { CLAY HARD GRASS }
      enum Status { OPEN CLOSED }
      input Filter { surface: Surface, name: String, legacy: String }
      type Court { id: ID!, status: Status }
      type Query { courts(filter: Filter): [Court!]! }
    `;
    const tested = [{ document: `{ courts(filter: { surface: CLAY }) { id } }` }];
    const usage = { fields: { "Query.courts": 50, "Filter.surface": 40, "Filter.name": 30, "Filter.legacy": 0, "Surface.CLAY": 20, "Surface.HARD": 10, "Status.OPEN": 7, "Gone.x": 1 } };

    it("joins inputs with what tests sent, apart from the output fields", () => {
      const r = computeCoverage(isdl, tested, { usage });
      expect(r.inputTypes.Filter.fields.name.requests).toBe(30);
      expect(r.enums.Surface.values.HARD.requests).toBe(10);
      expect(r.usage!.usedFields).toMatchObject({ covered: 1, total: 1 });
      expect(r.usage!.usedInputs).toMatchObject({ covered: 2, total: 4 }); // Filter.surface, Surface.CLAY of 4 with traffic
      expect(r.usage!.untestedUsed).toEqual([{ path: "Filter.name", requests: 30, kind: "inputField" }, { path: "Surface.HARD", requests: 10, kind: "enumValue" }]);
      expect(r.usage!.unusedUntested).toEqual(["Court.status", "Filter.legacy", "Surface.GRASS"]);
      expect(r.usage!.testedUnused).toEqual(["Court.id"]);
      expect(r.usage!.unknown).toEqual(["Gone.x"]); // Status.OPEN is an output-only enum value: in the schema, not joined
      expect(r.enums.Status.values.OPEN.requests).toBeUndefined();
    });

    it("gates on inputs, and explains when the usage data has none", () => {
      const r = computeCoverage(isdl, tested, { usage });
      expect(gate(r, { minUsedInputs: 50 }).passed).toBe(true);
      expect(gate(r, { minUsedInputs: 60 }).failures).toEqual(["50% of input fields and enum values with production traffic are sent by a test, below the minimum 60% (2 untested: Filter.name, Surface.HARD)"]);
      expect(gate(r, { minUsedFields: 100 }).passed).toBe(true); // input gaps do not count against output fields
      const outputsOnly = computeCoverage(isdl, tested, { usage: { fields: { "Query.courts": 1 } } });
      expect(gate(outputsOnly, { minUsedInputs: 1 }).failures[0]).toMatch(/needs production usage of input fields and enum values/);
      expect(gate(computeCoverage(isdl, []), { minUsedInputs: 1 }).failures[0]).toMatch(/needs production usage/);
    });

    it("keeps the inputs join through a merge", () => {
      const r = computeCoverage(isdl, tested, { usage });
      const m = mergeReports([r, computeCoverage(isdl, [{ document: `{ courts(filter: { name: "x", surface: HARD }) { id } }` }])]);
      expect(m.usage!.usedInputs).toMatchObject({ covered: 4, total: 4 });
    });
  });
});

