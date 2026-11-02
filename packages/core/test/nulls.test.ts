import { describe, expect, it } from "vitest";
import { computeCoverage, gate, mergeReports, summarise, toLcov } from "../src/index.js";

const sdl = `input PlayerPatch { name: String, nickname: String, ranking: Int!, tags: [String], club: ID = "none" }
type Player { id: ID! }
type Mutation { patchPlayer(id: ID!, patch: PlayerPatch!): Player }
type Query { player: Player }`;
const doc = `mutation ($p: PlayerPatch!) { patchPlayer(id: "1", patch: $p) { id } }`;

describe("explicit nulls on input fields", () => {
  const r = computeCoverage(sdl, [
    { document: doc, variables: { p: { name: null, ranking: 3, tags: ["a", null] } } },
    { document: `mutation { patchPlayer(id: "1", patch: { nickname: "x", ranking: 1, club: null }) { id } }` },
  ]);
  const f = r.inputTypes.PlayerPatch.fields;

  it("tells a field sent as null from one omitted, and from a null list item", () => {
    expect(f.name).toMatchObject({ nullable: true, sent: 1, omitted: 1, nulled: 1 });
    expect(f.tags).toMatchObject({ nullable: true, nulled: 0 });
    expect(f.tags.values.null).toBe(1);
    expect(f.club).toMatchObject({ nullable: true, nulled: 1 });
    expect(f.ranking).toMatchObject({ nullable: false, nulled: 0 });
  });

  it("summarises nullable fields seen as null", () => {
    expect(r.summary.inputFieldsNull).toEqual({ covered: 2, total: 4, percent: 50 });
  });

  it("leaves older reports without the flag at 0 of 0, and merges them", () => {
    const legacy = structuredClone(r);
    for (const x of Object.values(legacy.inputTypes.PlayerPatch.fields)) {
      delete x.nullable;
      delete x.nulled;
    }
    expect(summarise(legacy).inputFieldsNull).toEqual({ covered: 0, total: 0, percent: 100 });
    expect(mergeReports([legacy, legacy]).inputTypes.PlayerPatch.fields.name.nulled).toBeUndefined();
    expect(mergeReports([legacy, r]).inputTypes.PlayerPatch.fields.name.nulled).toBe(1);
    expect(mergeReports([r, legacy]).inputTypes.PlayerPatch.fields.name.nulled).toBe(1);
    expect(mergeReports([r, r]).summary.inputFieldsNull.covered).toBe(2);
  });

  it("gates on a minimum, and explains when the report predates the number", () => {
    expect(gate(r, { minInputNull: 50 }).passed).toBe(true);
    expect(gate(r, { minInputNull: 60 }).failures).toEqual(["50% of nullable input fields were sent as null, below the minimum 60%"]);
    const legacy = structuredClone(r) as unknown as { summary: Record<string, unknown> };
    delete legacy.summary.inputFieldsNull;
    expect(gate(legacy as never, { minInputNull: 1 }).failures).toEqual(["--min-input-null needs a report that tracks null inputs: run gqlcov report again"]);
  });

  it("adds a null arm to the LCOV branch of nullable input fields", () => {
    const lcov = toLcov(r, sdl, "schema.graphql");
    expect(lcov).toContain("BRDA:1,0,0,1\nBRDA:1,0,1,1\nBRDA:1,0,2,1"); // name: sent, omitted, null
    // ranking is required and non-null, so it has no branch: name, nickname, tags, club take branches 0 to 3.
    expect(lcov.match(/^BRDA:1,/gm)).toHaveLength(12);
    expect(lcov).toContain("BRDA:1,2,2,0"); // tags: never sent as null itself
  });
});
