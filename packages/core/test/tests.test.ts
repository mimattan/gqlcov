import { describe, expect, it } from "vitest";
import { computeCoverage, mergeReports, tagTest, testCoverage } from "../src/index.js";

const sdl = /* GraphQL */ `
  enum Surface { CLAY HARD }
  input Filter { surface: Surface, name: String }
  type Court { id: ID!, name: String }
  type Query { courts(filter: Filter, first: Int): [Court!]!, court(id: ID!): Court }
`;
const ops = [
  { document: `query ($f: Filter) { courts(filter: $f) { id } }`, variables: { f: { surface: "CLAY" } }, source: "list clay courts" },
  { document: `{ courts(filter: { name: "x" }, first: 1) { id name } }`, source: "search by name" },
  { document: `{ court(id: "1") { id } }`, source: "search by name" },
  { document: `{ court(id: "2") { name } }` },
];

describe("test attribution", () => {
  const r = computeCoverage(sdl, ops);

  it("tags fields, arguments, input fields and enum values with the tests that hit them", () => {
    expect(r.types.Court.fields.id.tests).toEqual(["list clay courts", "search by name"]);
    expect(r.types.Court.fields.name.tests).toEqual(["search by name"]); // the unlabelled capture adds nothing
    expect(r.types.Query.fields.courts.args.first.tests).toEqual(["search by name"]);
    expect(r.inputTypes.Filter.fields.surface.tests).toEqual(["list clay courts"]);
    expect(r.inputTypes.Filter.fields.name.tests).toEqual(["search by name"]);
    expect(r.enums.Surface.values.CLAY.tests).toEqual(["list clay courts"]);
    expect(r.enums.Surface.values.HARD.tests).toBeUndefined();
    expect(r.tests).toEqual({ "list clay courts": 1, "search by name": 2 });
  });

  it("summarises each test, with what only it covers", () => {
    const [clay, search] = testCoverage(r);
    expect(clay).toEqual({
      name: "list clay courts",
      operations: 1,
      fields: ["Court.id", "Query.courts"],
      arguments: ["Query.courts(filter)"],
      inputFields: ["Filter.surface"],
      enumValues: ["Surface.CLAY"],
      unique: ["Filter.surface", "Surface.CLAY"],
    });
    expect(search.unique).toEqual(["Court.name", "Filter.name", "Query.court", "Query.court(id)", "Query.courts(first)"]);
  });

  it("lists tests that ran but covered nothing, and nothing for unlabelled runs", () => {
    const quiet = computeCoverage(sdl, [{ document: `{ nope }`, source: "broken" }, { document: `{ __typename }`, source: "ping" }]);
    expect(testCoverage(quiet)).toEqual([{ name: "ping", operations: 1, fields: [], arguments: [], inputFields: [], enumValues: [], unique: [] }]);
    expect(computeCoverage(sdl, [{ document: `{ court(id: "1") { id } }` }]).tests).toBeUndefined();
    expect(testCoverage(computeCoverage(sdl, []))).toEqual([]);
  });

  it("counts a capture naming a missing operation as invalid, fragments included", () => {
    const r = computeCoverage(sdl, [{ document: `query A { ...F } fragment F on Query { court(id: "1") { id } }`, operationName: "B", source: "typo" }]);
    expect(r.operations).toMatchObject({ total: 0, invalid: 1 });
    expect(r.types.Court.fields.id.hits).toBe(0);
    expect(r.tests).toBeUndefined();
  });

  it("keeps a sorted, duplicate-free list", () => {
    const el: { tests?: string[] } = {};
    for (const t of ["b", "a", "b", undefined, ""]) tagTest(el, t);
    expect(el.tests).toEqual(["a", "b"]);
  });

  it("unions tests and adds operation counts on merge", () => {
    const other = computeCoverage(sdl, [{ document: `{ court(id: "3") { name } }`, source: "detail page" }, { document: `{ courts(first: 2) { id } }`, source: "search by name" }]);
    const m = mergeReports([r, other]);
    expect(m.types.Court.fields.name.tests).toEqual(["detail page", "search by name"]);
    expect(m.types.Query.fields.courts.args.first.tests).toEqual(["search by name"]);
    expect(m.tests).toEqual({ "detail page": 1, "list clay courts": 1, "search by name": 3 });
    const unlabelled = mergeReports([computeCoverage(sdl, []), computeCoverage(sdl, [])]);
    expect(unlabelled.tests).toBeUndefined();
    expect(mergeReports([computeCoverage(sdl, []), r]).inputTypes.Filter.fields.surface.tests).toEqual(["list clay courts"]);
    const narrow = computeCoverage(sdl, [], { exclude: ["Query.courts(first)"] });
    expect(mergeReports([narrow, r]).types.Query.fields.courts.args.first).toBeUndefined();
  });
});
