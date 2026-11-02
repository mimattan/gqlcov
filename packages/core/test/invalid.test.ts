import { describe, expect, it } from "vitest";
import { computeCoverage, gate, mergeReports } from "../src/index.js";

const sdl = `type Club { id: ID!, name: String! } type Query { club(id: ID!): Club }`;

describe("invalid operations", () => {
  const r = computeCoverage(sdl, [
    { document: `query Old { club(id: "1") { gone } }`, source: "a.spec" },
    { document: `query Old { club(id: "1") { gone } }`, source: "b.spec" },
    { document: `query Old { club(id: "1") { gone } }`, source: "a.spec" },
    { document: `query Broken { club(id: "1" { id } }` },
    { document: `{ nope }`, operationName: null },
    { document: `query Named { club(id: "1") { id } }` },
  ]);

  it("lists each one by name and errors, with counts and sources, without counting it", () => {
    expect(r.operations).toMatchObject({ total: 1, invalid: 5 });
    expect(r.invalid).toEqual([
      { operationName: "Old", errors: [`Cannot query field "gone" on type "Club".`], count: 3, sources: ["a.spec", "b.spec"] },
      { operationName: "Broken", errors: [expect.stringContaining("Syntax Error")], count: 1, sources: [] },
      { operationName: null, errors: [`Cannot query field "nope" on type "Query".`], count: 1, sources: [] },
    ]);
  });

  it("leaves the list out when every document is valid", () => {
    expect(computeCoverage(sdl, [{ document: `{ club(id: "1") { id } }` }]).invalid).toBeUndefined();
  });

  it("keeps at most ten sources per entry", () => {
    const many = computeCoverage(sdl, Array.from({ length: 12 }, (_, i) => ({ document: `{ nope }`, source: `t${i}` })));
    expect(many.invalid![0]).toMatchObject({ count: 12, sources: Array.from({ length: 10 }, (_, i) => `t${i}`) });
  });

  it("merges lists from shards", () => {
    const other = computeCoverage(sdl, [{ document: `query Old { club(id: "1") { gone } }`, source: "c.spec" }, { document: `query Other { x }` }]);
    const m = mergeReports([r, other, computeCoverage(sdl, [])]);
    expect(m.operations.invalid).toBe(7);
    expect(m.invalid!.find((x) => x.operationName === "Old")).toMatchObject({ count: 4, sources: ["a.spec", "b.spec", "c.spec"] });
    expect(m.invalid!.map((x) => x.operationName)).toEqual(["Old", "Broken", null, "Other"]);
    expect(mergeReports([computeCoverage(sdl, []), other]).invalid).toHaveLength(2);
  });

  it("gates on a maximum", () => {
    expect(gate(r, { maxInvalid: 5 }).passed).toBe(true);
    const failed = gate(r, { maxInvalid: 0 });
    expect(failed.failures).toEqual([`5 captured operations do not validate against the schema, above the maximum 0 (Old: Cannot query field "gone" on type "Club".; Broken: ${r.invalid![1].errors[0]}; (anonymous): Cannot query field "nope" on type "Query".)`]);
    const six = computeCoverage(sdl, Array.from({ length: 6 }, (_, i) => ({ document: `query Q${i} { x${i} }` })));
    expect(gate(six, { maxInvalid: 1 }).failures[0]).toMatch(/; \.\.\.\)$/);
    const legacy = { ...r, invalid: undefined };
    expect(gate(legacy, { maxInvalid: 0 }).failures[0]).toBe("5 captured operations do not validate against the schema, above the maximum 0");
  });
});
