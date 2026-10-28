import { describe, expect, it } from "vitest";
import { computeCoverage, schemaLineMap, toIstanbul, toLcov } from "../src/index.js";

const sdl = `type Query {
  player(id: ID!): Player
  matches(filter: MatchFilter, first: Int): [Match!]!
}
type Player { id: ID!, name: String! }
type Match { id: ID! }
input MatchFilter {
  surface: Surface
  clubId: ID
}
enum Surface { CLAY HARD }
extend type Query { clubs: [String!]! }`;

describe("export", () => {
  const report = computeCoverage(sdl, [{ document: `query ($f: MatchFilter) { matches(filter: $f) { id } }`, variables: { f: { surface: "CLAY" } } }]);

  it("maps elements to SDL lines, extensions included", () => {
    const m = schemaLineMap(sdl);
    expect(m.get("Query.player")).toBe(2);
    expect(m.get("Query.matches(first)")).toBe(3);
    expect(m.get("MatchFilter.clubId")).toBe(9);
    expect(m.get("Surface.HARD")).toBe(11);
    expect(m.get("Query.clubs")).toBe(12);
  });

  it("writes lcov with lines, functions and branches", () => {
    const l = toLcov(report, sdl, "schema.graphql");
    expect(l).toContain("SF:schema.graphql");
    expect(l).toContain("FN:3,Query.matches");
    expect(l).toContain("FNDA:1,Query.matches");
    expect(l).toContain("FNDA:0,Query.player");
    expect(l).toContain("DA:3,1");
    expect(l).toContain("DA:2,0");
    expect(l).toContain("DA:11,1"); // CLAY
    expect(l).toMatch(/BRDA:3,\d+,0,1/); // matches(filter) hit
    expect(l).toMatch(/BRDA:3,\d+,1,0/); // matches(first) not hit
    expect(l).toMatch(/BRDA:8,\d+,0,1/); // surface sent
    expect(l).toMatch(/BRDA:8,\d+,1,0/); // surface never omitted
    expect(l).toContain("LF:8");
    expect(l).toContain("LH:4"); // matches, Match.id, surface, CLAY
  });

  it("writes istanbul json", () => {
    const i = toIstanbul(report, sdl, "schema.graphql") as Record<string, { s: Record<string, number>; f: Record<string, number>; b: Record<string, number[]> }>;
    const file = i["schema.graphql"];
    expect(Object.keys(file.s)).toHaveLength(10);
    expect(Object.values(file.f)).toEqual([0, 1, 0]); // player, matches, clubs in line order
    expect(Object.values(file.b)).toContainEqual([1, 0]);
  });
});
