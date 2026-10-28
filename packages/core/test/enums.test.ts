import { describe, expect, it } from "vitest";
import { buildSchema } from "graphql";
import { collectResponseEnums, computeCoverage, gate, mergeReports, toLcov, uncovered } from "../src/index.js";

const sdl = /* GraphQL */ `
  enum Surface { CLAY HARD }
  enum Status { OPEN CLOSED }
  enum Role { ADMIN USER }
  enum Unused { A }
  enum AdminOnly { X Y }
  input Filter { surface: Surface, nested: Nested }
  input Nested { role: Role }
  interface Node { id: ID! }
  type Court implements Node { id: ID!, surface: Surface!, status: Status! }
  type Club implements Node { id: ID!, statuses: [Status!]! }
  type Query {
    courts(filter: Filter): [Court!]!
    node(id: ID!): Node
    admin(mode: AdminOnly): Int
  }
`;

describe("enum reachability", () => {
  it("splits enums into input-reachable and output", () => {
    const r = computeCoverage(sdl, []);
    expect(r.enums.Surface).toMatchObject({ input: true, output: true });
    expect(r.enums.Status).toMatchObject({ input: false, output: true });
    expect(r.enums.Role).toMatchObject({ input: true, output: false }); // through Filter.nested
    expect(r.enums.Unused).toMatchObject({ input: false, output: false });
    expect(r.summary.enumValues.total).toBe(6); // Surface, Role, AdminOnly
    expect(r.summary.enumValuesObserved.total).toBe(4); // Surface, Status
  });

  it("drops enums only reachable through excluded arguments", () => {
    const r = computeCoverage(sdl, [], { exclude: ["Query.admin"] });
    expect(r.enums.AdminOnly.input).toBe(false);
    expect(r.summary.enumValues.total).toBe(4);
  });

  it("keeps output-only values out of uncovered, LCOV and the gate", () => {
    const base = computeCoverage(sdl, [
      { document: `{ courts { id status } }`, responseEnums: { Status: ["OPEN", "CLOSED"] } },
    ]);
    const head = computeCoverage(sdl, [{ document: `{ courts { id status } }`, responseEnums: { Status: ["OPEN"] } }]);
    expect(base.enums.Status.values.CLOSED.observed).toBe(1);
    expect(base.summary.enumValuesObserved.covered).toBe(2);
    expect(head.summary.enumValuesObserved.covered).toBe(1);
    expect(gate(head, { base }).passed).toBe(true);
    expect(uncovered(head).enumValues).not.toContain("Status.OPEN");
    const lcov = toLcov(head, sdl, "schema.graphql");
    expect(lcov).not.toMatch(/^DA:3,/m); // line 3 is "enum Status"
  });

  it("merges observed counts", () => {
    const op = { document: `{ courts { id } }`, responseEnums: { Status: ["OPEN", "OPEN"] } };
    const m = mergeReports([computeCoverage(sdl, [op]), computeCoverage(sdl, [op])]);
    expect(m.enums.Status.values.OPEN.observed).toBe(2);
  });

  it("reads reports written before the split", () => {
    const r = computeCoverage(sdl, []);
    const old = structuredClone(r) as typeof r;
    for (const e of Object.values(old.enums)) {
      delete (e as Partial<typeof e>).input;
      delete (e as Partial<typeof e>).output;
    }
    delete (old.summary as Partial<typeof old.summary>).enumValuesObserved;
    expect(gate(r, { base: old }).passed).toBe(true);
  });
});

describe("collectResponseEnums", () => {
  const schema = buildSchema(sdl);

  it("follows aliases, lists, inline fragments and named fragments", () => {
    const doc = `
      query Q { courts { s: surface status } node(id: "1") { ...C ... on Club { statuses } } }
      fragment C on Court { status }
    `;
    const data = {
      courts: [{ s: "CLAY", status: "OPEN" }, { s: "HARD", status: "OPEN" }],
      node: { __typename: "Club", statuses: ["CLOSED"] },
    };
    expect(collectResponseEnums(schema, doc, data, "Q")).toEqual({ Surface: ["CLAY", "HARD"], Status: ["CLOSED", "OPEN"] });
  });

  it("handles null data and missing keys", () => {
    expect(collectResponseEnums(schema, `{ courts { status } }`, { courts: null })).toEqual({});
    expect(collectResponseEnums(schema, `{ node(id: "1") { id } }`, null)).toEqual({});
  });
});
