import { describe, expect, it } from "vitest";
import { computeCoverage, diffReports, gate, mergeReports, uncovered } from "../src/index.js";

const sdl = /* GraphQL */ `
  enum Surface { CLAY HARD GRASS INDOOR }
  input ScoreInput { games: Int!, tiebreak: Int }
  input MatchFilter { surface: Surface, clubId: ID, playedAfter: String, sets: [ScoreInput!] }
  type Player { id: ID!, name: String!, rating: Float, deprecatedField: String @deprecated(reason: "no") }
  type Match { id: ID!, surface: Surface!, players: [Player!]! }
  type Query {
    player(id: ID!): Player
    matches(filter: MatchFilter, first: Int = 10): [Match!]!
  }
  type Mutation { createMatch(filter: MatchFilter!): Match! }
  type Subscription { matchStarted: Match! }
`;

describe("computeCoverage", () => {
  it("starts at zero with every included element present", () => {
    const r = computeCoverage(sdl, []);
    expect(r.summary.fields.covered).toBe(0);
    expect(r.types.Player.fields.deprecatedField).toBeUndefined();
    expect(r.inputTypes.MatchFilter.fields.surface.required).toBe(false);
    expect(r.inputTypes.ScoreInput.fields.games.required).toBe(true);
    expect(Object.keys(r.enums.Surface.values)).toHaveLength(4);
    expect(r.types.__Type).toBeUndefined();
  });

  it("counts output fields, arguments and operation types", () => {
    const r = computeCoverage(sdl, [
      { document: `query P($id: ID!) { player(id: $id) { id name } }`, operationName: "P", variables: { id: "1" } },
      { document: `mutation { createMatch(filter: { surface: CLAY }) { id } }` },
    ]);
    expect(r.operations).toMatchObject({ total: 2, query: 1, mutation: 1, invalid: 0 });
    expect(r.types.Query.fields.player.hits).toBe(1);
    expect(r.types.Query.fields.player.args.id.hits).toBe(1);
    expect(r.types.Player.fields.name.hits).toBe(1);
    expect(r.types.Player.fields.rating.hits).toBe(0);
    expect(r.types.Query.fields.matches.hits).toBe(0);
    expect(r.types.Mutation.fields.createMatch.hits).toBe(1);
    expect(r.enums.Surface.values.CLAY.hits).toBe(1);
  });

  it("walks input-type fields through variables, including nested lists", () => {
    const r = computeCoverage(sdl, [
      {
        document: `query M($f: MatchFilter) { matches(filter: $f) { id } }`,
        variables: { f: { surface: "HARD", clubId: null, sets: [{ games: 6 }, { games: 7, tiebreak: 10 }] } },
      },
      { document: `query M2($f: MatchFilter) { matches(filter: $f) { id } }`, variables: { f: {} } },
    ]);
    const mf = r.inputTypes.MatchFilter.fields;
    expect(mf.surface).toMatchObject({ sent: 1, omitted: 1 });
    expect(mf.clubId).toMatchObject({ sent: 1, omitted: 1 });
    expect(mf.clubId.values.null).toBe(1);
    expect(mf.playedAfter).toMatchObject({ sent: 0, omitted: 2 });
    expect(mf.sets.values.listMany).toBe(1);
    const si = r.inputTypes.ScoreInput.fields;
    expect(si.games.sent).toBe(2);
    expect(si.games.values.positive).toBe(2);
    expect(si.tiebreak).toMatchObject({ sent: 1, omitted: 1 });
    expect(r.enums.Surface.values.HARD.hits).toBe(1);
    expect(r.summary.inputFieldsBothStates.covered).toBe(4); // surface, clubId, sets, tiebreak
    expect(r.argumentValues["Query.matches(filter)"].typical).toBe(2);
  });

  it("treats an unsupplied variable as an absent argument", () => {
    const r = computeCoverage(sdl, [{ document: `query ($n: Int) { matches(first: $n) { id } }`, variables: {} }]);
    expect(r.types.Query.fields.matches.hits).toBe(1);
    expect(r.types.Query.fields.matches.args.first.hits).toBe(0);
  });

  it("counts invalid documents without crashing", () => {
    const r = computeCoverage(sdl, [{ document: `{ nope }` }, { document: `{ player(id: "1" { id }` }]);
    expect(r.operations.invalid).toBe(2);
    expect(r.operations.total).toBe(0);
  });

  it("respects exclude patterns", () => {
    const r = computeCoverage(sdl, [], { exclude: ["Subscription", "Query.matches(*)", "Match.*"] });
    expect(r.types.Subscription).toBeUndefined();
    expect(r.types.Query.fields.matches.args).toEqual({});
    expect(r.types.Match.fields).toEqual({});
  });

  it("only records the selected operation from a multi-operation document", () => {
    const doc = `query A { player(id: "1") { id } } query B { matches { id } }`;
    const r = computeCoverage(sdl, [{ document: doc, operationName: "B" }]);
    expect(r.types.Query.fields.player.hits).toBe(0);
    expect(r.types.Query.fields.matches.hits).toBe(1);
    expect(r.operations.total).toBe(1);
  });
});

describe("merge, diff, gate", () => {
  const a = computeCoverage(sdl, [{ document: `{ player(id: "1") { id } }` }]);
  const b = computeCoverage(sdl, [{ document: `{ matches { id surface } }` }]);

  it("merges shards", () => {
    const m = mergeReports([a, b]);
    expect(m.operations.total).toBe(2);
    expect(m.types.Query.fields.player.hits).toBe(1);
    expect(m.types.Query.fields.matches.hits).toBe(1);
    expect(m.summary.fields.covered).toBe(a.summary.fields.covered + b.summary.fields.covered);
  });

  it("refuses to merge different schemas", () => {
    const other = computeCoverage(`type Query { x: Int }`, []);
    expect(() => mergeReports([a, other])).toThrow(/schema hashes differ/);
  });

  it("diffs coverage", () => {
    const d = diffReports(a, b);
    expect(d.newlyCovered).toContain("Query.matches");
    expect(d.lostCoverage).toContain("Query.player");
    expect(d.lostCoverage).toContain("Query.player(id)");
  });

  it("gates on minimum and on decrease", () => {
    expect(gate(a, { minFields: 1 }).passed).toBe(true);
    expect(gate(a, { minFields: 99 }).passed).toBe(false);
    expect(gate(b, { base: a }).passed).toBe(false);
    expect(gate(mergeReports([a, b]), { base: a }).passed).toBe(true);
  });

  it("lists uncovered elements", () => {
    const u = uncovered(a);
    expect(u.fields).toContain("Mutation.createMatch");
    expect(u.inputFields).toContain("MatchFilter.surface");
    expect(u.enumValues).toContain("Surface.GRASS");
  });
});
