import { describe, expect, it } from "vitest";
import { buildSchema, graphql } from "graphql";
import { collectResponse, collectResponseShape, computeCoverage, mergeReports, toMarkdown, uncovered } from "../src/index.js";

const sdl = `type Club { id: ID!, name: String, logo: String, owner: Person, members: [Person!]! }
type Person { name: String! }
union Thing = Club | Person
type Query { clubs: [Club!]!, club: Club!, things: [Thing!]!, hidden: Int }`;
const schema = buildSchema(sdl);
(schema.getType("Thing") as unknown as { resolveType: (v: { kind: string }) => string }).resolveType = (v) => v.kind;
const rootValue = {
  clubs: () => [
    { id: "1", name: "A", logo: null, owner: null, members: [] },
    { id: "2", name: null, logo: null, owner: () => { throw new Error("no owner"); }, members: [] },
  ],
  club: () => { throw new Error("down"); },
  things: () => [{ kind: "Club", name: "C" }, { kind: "Person", name: "p" }],
};
const exec = (source: string) => graphql({ schema, source, rootValue });

describe("collectResponse with errors", () => {
  it("records a null an error points at as an error, and leaves a sibling's plain null alone", async () => {
    const q = `{ clubs { id owner { name } logo } }`;
    const res = await exec(q);
    const facts = collectResponse(schema, q, res.data, undefined, res.errors);
    expect(facts.values["Club.owner"]).toEqual(["error", "null"]); // item 0 plain null, item 1 failed
    expect(facts.values["Club.logo"]).toEqual(["null"]);
  });

  it("records fields an error propagated out of the data, through aliases and fragments", async () => {
    const q = `query { top: club { ...F } } fragment F on Club { id owner { name } }`;
    const res = await exec(q);
    expect(res.data).toBeNull();
    const facts = collectResponse(schema, q, res.data, undefined, res.errors);
    expect(facts.values).toEqual({ "Query.club": ["error"] });
    // An error deeper than where the data stops: every field on its path that the data lacks failed.
    const deep = collectResponse(schema, `{ clubs { owner { name } } }`, null, undefined, [{ path: ["clubs", 0, "owner", "name"] }, { path: ["clubs", 1, "ghost"] }, {}]);
    expect(deep.values).toEqual({ "Query.clubs": ["error"], "Club.owner": ["error"], "Person.name": ["error"] });
  });

  it("follows errors through untyped inline fragments and tolerates documents that would not validate", () => {
    const q = `{ clubs { ... { owner { name } } ...Missing ... on Ghost { id } __typename } } fragment Unused on Club { id }`;
    const facts = collectResponse(schema, q, { clubs: null }, undefined, [{ path: ["clubs", 0, "owner"] }, { path: ["clubs", "__typename"] }]);
    expect(facts.values).toEqual({ "Query.clubs": ["error"], "Club.owner": ["error"] });
  });

  it("keeps its old answers without errors", async () => {
    const q = `{ clubs { name members { name } } }`;
    const res = await exec(q);
    expect(collectResponse(schema, q, res.data).values).toEqual({ "Query.clubs": ["value"], "Club.name": ["null", "value"], "Club.members": ["empty"] });
  });
});

describe("collectResponseShape (wire capture)", () => {
  it("marks values, nulls, empty lists and errors per path, dropping list indexes", () => {
    const shape = collectResponseShape({ clubs: [{ id: "1", logo: null, owner: null, members: [] }, { id: "2", logo: "l", owner: null, members: [{ name: "x" }] }] }, [{ path: ["clubs", 1, "owner"] }]);
    expect(shape).toEqual({ clubs: 1, "clubs.id": 1, "clubs.logo": 3, "clubs.owner": 6, "clubs.members": 9, "clubs.members.name": 1 });
  });

  it("marks a path an error removed from the data, and ignores errors without a path and null list items", () => {
    expect(collectResponseShape(null, [{ path: ["club", "owner"] }, {}, { path: [] }])).toEqual({ club: 4, "club.owner": 4 });
    expect(collectResponseShape({ ids: [null, "1"] })).toEqual({ ids: 1 });
    expect(collectResponseShape({ ids: [null, "x"] }, [{ path: ["ids", 0] }])).toEqual({ ids: 5 });
    expect(collectResponseShape(undefined)).toEqual({});
  });
});

describe("response outcomes in the report", () => {
  it("resolves wire shapes to fields through aliases, fragments and union type conditions", async () => {
    const q = `query { clubs { id name pic: logo owner { name } ...F } things { ... on Club { name } ... on Person { pname: name } } } fragment F on Club { members { name } }`;
    const res = await exec(q);
    const r = computeCoverage(sdl, [{ document: q, responseShape: collectResponseShape(res.data, res.errors) }, { document: `{ club { id } }`, responseShape: { club: 4 } }]);
    const c = r.types.Club.fields;
    expect(c.id.returned).toEqual({ value: 1, null: 0, empty: 0 });
    expect(c.name.returned).toEqual({ value: 1, null: 1, empty: 0 });
    expect(c.logo.returned).toEqual({ value: 0, null: 1, empty: 0 });
    expect(c.owner.returned).toEqual({ value: 0, null: 1, empty: 0, error: 1 });
    expect(c.members.returned).toEqual({ value: 0, null: 0, empty: 1 });
    expect(r.types.Person.fields.name.returned).toEqual({ value: 1, null: 0, empty: 0 });
    expect(r.types.Query.fields.club.returned).toEqual({ value: 0, null: 0, empty: 0, error: 1 });
    expect(r.operations.responses).toBe(2);
    const u = uncovered(r);
    expect(u.errored).toEqual(["Club.owner", "Query.club"]);
    expect(u.neverReturned).toEqual(["Club.logo", "Club.members", "Club.owner", "Query.club"]);
    expect(toMarkdown(r)).toContain("Returned an error");
  });

  it("uses the named operation and skips __typename, excluded fields and unselected paths", () => {
    const doc = `query A { clubs { id } } query B { clubs { __typename ... { id } } }`;
    const r = computeCoverage(sdl, [{ document: doc, operationName: "B", responseShape: { clubs: 1, "clubs.__typename": 1, "clubs.id": 2, "clubs.ghost": 1, "nowhere.id": 1 } }], { exclude: ["Club.id"] });
    expect(r.types.Query.fields.clubs.returned).toEqual({ value: 1, null: 0, empty: 0 });
    const missing = computeCoverage(sdl, [{ document: doc, operationName: "C", responseShape: { clubs: 1 } }]);
    expect(missing.types.Query.fields.clubs.returned).toBeUndefined();
    expect(missing.operations.responses).toBeUndefined();
  });

  it("prefers server outcomes over a shape, and merges error counts, keeping older reports without them", () => {
    const server = computeCoverage(sdl, [{ document: `{ club { id } }`, responseValues: { "Query.club": ["value"] }, responseShape: { club: 4 } }]);
    expect(server.types.Query.fields.club.returned).toEqual({ value: 1, null: 0, empty: 0 });
    const failed = computeCoverage(sdl, [{ document: `{ club { id } }`, responseShape: { club: 4 } }]);
    const m = mergeReports([server, failed, failed]);
    expect(m.types.Query.fields.club.returned).toEqual({ value: 1, null: 0, empty: 0, error: 2 });
    expect(mergeReports([failed, server]).types.Query.fields.club.returned).toEqual({ value: 1, null: 0, empty: 0, error: 1 });
  });
});
