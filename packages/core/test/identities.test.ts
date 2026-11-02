import { describe, expect, it } from "vitest";
import { computeCoverage, gate, identityGaps, mergeReports, summariseIdentities } from "../src/index.js";

const sdl = `type Club { id: ID!, name: String!, revenue: Int }
type Query { club(id: ID!): Club }
type Mutation { renameClub(id: ID!, name: String!): Club, deleteClub(id: ID!): Boolean, closeClub(id: ID!): Boolean }`;

describe("coverage per identity", () => {
  const r = computeCoverage(sdl, [
    { document: `{ club(id: "1") { id name revenue } }`, identity: "admin" },
    { document: `{ club(id: "1") { id name } }`, identity: "guest" },
    { document: `{ club(id: "1") { id } }`, identity: "guest" },
    { document: `mutation { renameClub(id: "1", name: "x") { id } }`, identity: "admin" },
    { document: `mutation { renameClub(id: "1", name: "x") { id } }`, identity: "guest" },
    { document: `mutation { deleteClub(id: "1") }`, identity: "admin" },
    { document: `mutation { closeClub(id: "1") }` },
  ]);

  it("counts requests per identity on each field", () => {
    expect(r.types.Club.fields.id.identities).toEqual({ admin: 2, guest: 3 }); // the guest's rename selects id too
    expect(r.types.Club.fields.revenue.identities).toEqual({ admin: 1 });
    expect(r.types.Mutation.fields.closeClub.identities).toBeUndefined();
  });

  it("summarises output-field coverage per identity, sorted by name", () => {
    expect(Object.keys(r.identities!)).toEqual(["admin", "guest"]);
    expect(r.identities!.admin).toEqual({ covered: 6, total: 7, percent: 85.71 });
    expect(r.identities!.guest).toEqual({ covered: 4, total: 7, percent: 57.14 });
    expect(computeCoverage(sdl, [{ document: `{ club(id: "1") { id } }` }]).identities).toBeUndefined();
    expect(summariseIdentities({ types: { T: { kind: "OBJECT", hits: 0, fields: { f: { hits: 1, deprecated: false, args: {}, identities: { a: 0 } } } } } })).toBeUndefined();
  });

  it("finds requested fields in scope with too few identities", () => {
    expect(identityGaps(r, 2)).toEqual([
      { path: "Mutation.closeClub", identities: [] },
      { path: "Mutation.deleteClub", identities: ["admin"] },
    ]);
    expect(identityGaps(r, 2, ["Club.*"])).toEqual([{ path: "Club.revenue", identities: ["admin"] }]);
    expect(identityGaps(r, 1, ["Query.club", "Mutation.rename*"])).toEqual([]);
  });

  it("gates on a minimum number of identities", () => {
    expect(gate(r, { minIdentities: 1, identityScope: ["Club.*"] }).passed).toBe(true);
    expect(gate(r, { minIdentities: 2 }).failures).toEqual(["2 fields in Mutation.* were requested by fewer than 2 identities: Mutation.closeClub (no identity), Mutation.deleteClub (as admin)"]);
    expect(gate(r, { minIdentities: 2, identityScope: [] }).failures[0]).toMatch(/^2 fields in Mutation\.\*/);
    expect(gate(r, { minIdentities: 3, identityScope: ["*.*"] }).failures[0]).toMatch(/^7 fields in \*\.\* were requested by fewer than 3 identities: .*Query\.club \(as admin, guest\)$/);
    const wide = Array.from({ length: 11 }, (_, i) => `m${i}: Int`).join(", ");
    const many = computeCoverage(`type Query { a: Int } type Mutation { ${wide} }`, [{ document: `mutation { ${Array.from({ length: 11 }, (_, i) => `m${i}`).join(" ")} }`, identity: "admin" }]);
    expect(gate(many, { minIdentities: 2 }).failures[0]).toMatch(/^11 fields in Mutation\.\* .*Mutation\.m8 \(as admin\), \.\.\.$/);
    expect(gate(computeCoverage(sdl, []), { minIdentities: 1 }).failures).toEqual(["--min-identities needs captures that carry an identity (the capture layer's identity option)"]);
  });

  it("merges identity counts from shards", () => {
    const other = computeCoverage(sdl, [{ document: `mutation { deleteClub(id: "1") }`, identity: "guest" }]);
    const m = mergeReports([computeCoverage(sdl, []), r, other]);
    expect(m.types.Mutation.fields.deleteClub.identities).toEqual({ admin: 1, guest: 1 });
    expect(m.identities!.guest.covered).toBe(5);
    expect(mergeReports([computeCoverage(sdl, []), computeCoverage(sdl, [])]).identities).toBeUndefined();
  });
});
