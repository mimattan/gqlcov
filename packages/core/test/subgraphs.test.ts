import { describe, expect, it } from "vitest";
import { computeCoverage, diffReports, gate, mergeReports, subgraphsFromSdls } from "../src/index.js";

const supergraph = /* GraphQL */ `
  schema
    @link(url: "https://specs.apollo.dev/link/v1.0")
    @link(url: "https://specs.apollo.dev/join/v0.3", for: EXECUTION)
  { query: Query mutation: Mutation }

  directive @join__enumValue(graph: join__Graph!) repeatable on ENUM_VALUE
  directive @join__field(graph: join__Graph, requires: join__FieldSet, provides: join__FieldSet, type: String, external: Boolean, override: String, usedOverridden: Boolean) repeatable on FIELD_DEFINITION | INPUT_FIELD_DEFINITION
  directive @join__graph(name: String!, url: String!) on ENUM_VALUE
  directive @join__implements(graph: join__Graph!, interface: String!) repeatable on OBJECT | INTERFACE
  directive @join__type(graph: join__Graph!, key: join__FieldSet, extension: Boolean! = false, resolvable: Boolean! = true, isInterfaceObject: Boolean! = false) repeatable on OBJECT | INTERFACE | UNION | ENUM | INPUT_OBJECT | SCALAR
  directive @join__unionMember(graph: join__Graph!, member: String!) repeatable on UNION
  directive @link(url: String, as: String, for: link__Purpose, import: [link__Import]) repeatable on SCHEMA

  scalar join__FieldSet
  scalar link__Import
  enum link__Purpose { SECURITY EXECUTION }
  enum join__Graph {
    CLUBS @join__graph(name: "clubs", url: "http://clubs/graphql")
    PLAYERS @join__graph(name: "players", url: "http://players/graphql")
  }

  enum Surface @join__type(graph: CLUBS) @join__type(graph: PLAYERS) {
    CLAY @join__enumValue(graph: CLUBS) @join__enumValue(graph: PLAYERS)
    HARD @join__enumValue(graph: CLUBS)
  }
  input PlayerFilter @join__type(graph: PLAYERS) { clubId: ID, surface: Surface }
  type Club @join__type(graph: CLUBS, key: "id") @join__type(graph: PLAYERS, key: "id") {
    id: ID!
    name: String! @join__field(graph: CLUBS)
    players: [Player!]! @join__field(graph: PLAYERS)
  }
  type Player @join__type(graph: CLUBS, key: "id") @join__type(graph: PLAYERS, key: "id") {
    id: ID!
    name: String! @join__field(graph: PLAYERS)
    rating: Float @join__field(graph: PLAYERS, external: true) @join__field(graph: CLUBS)
  }
  type Query @join__type(graph: CLUBS) @join__type(graph: PLAYERS) {
    clubs: [Club!]! @join__field(graph: CLUBS)
    players(filter: PlayerFilter): [Player!]! @join__field(graph: PLAYERS)
  }
  type Mutation @join__type(graph: PLAYERS) {
    renamePlayer(id: ID!, name: String!): Player!
  }
`;

const clubsSdl = /* GraphQL */ `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@external", "@requires"])
  enum Surface { CLAY HARD }
  type Club @key(fields: "id") { id: ID!, name: String! }
  type Player @key(fields: "id") { id: ID!, rating: Float }
  type Query { clubs: [Club!]!, _service: _Service! }
  scalar _Any
  type _Service { sdl: String }
`;
const playersSdl = /* GraphQL */ `
  enum Surface { CLAY }
  input PlayerFilter { clubId: ID, surface: Surface }
  type Club @key(fields: "id") { id: ID!, players: [Player!]! }
  type Player @key(fields: "id") { id: ID!, name: String!, rating: Float @external }
  type Query { players(filter: PlayerFilter): [Player!]! }
  type Mutation { renamePlayer(id: ID!, name: String!): Player! }
`;

describe("supergraph attribution", () => {
  const r = computeCoverage(supergraph, [
    { document: `{ clubs { id name } }` },
    { document: `query P($f: PlayerFilter) { players(filter: $f) { id } }`, variables: { f: { surface: "CLAY" } } },
  ]);

  it("leaves join and link machinery out of the totals", () => {
    expect(r.enums.join__Graph).toBeUndefined();
    expect(r.enums.link__Purpose).toBeUndefined();
    expect(Object.keys(r.enums)).toEqual(["Surface"]);
  });

  it("tags elements with the subgraphs that own them", () => {
    expect(r.types.Club.graphs).toEqual(["clubs", "players"]);
    expect(r.types.Club.fields.id.graphs).toEqual(["clubs", "players"]); // no @join__field: every subgraph of the type
    expect(r.types.Club.fields.name.graphs).toEqual(["clubs"]);
    expect(r.types.Club.fields.players.graphs).toEqual(["players"]);
    expect(r.types.Player.fields.rating.graphs).toEqual(["clubs"]); // external in players
    expect(r.types.Mutation.fields.renamePlayer.graphs).toEqual(["players"]);
    expect(r.inputTypes.PlayerFilter.fields.clubId.graphs).toEqual(["players"]);
    expect(r.enums.Surface.values.HARD.graphs).toEqual(["clubs"]);
    expect(r.enums.Surface.values.CLAY.graphs).toEqual(["clubs", "players"]);
  });

  it("summarises per subgraph, counting shared elements in each", () => {
    expect(Object.keys(r.subgraphs!)).toEqual(["clubs", "players"]);
    // clubs: Club.id, Club.name, Player.id, Player.rating, Query.clubs -> 4 covered (all but Player.rating)
    expect(r.subgraphs!.clubs.fields).toMatchObject({ covered: 4, total: 5 });
    // players: Club.id, Club.players, Player.id, Player.name, Query.players, Mutation.renamePlayer -> Club.id, Player.id, Query.players
    expect(r.subgraphs!.players.fields).toMatchObject({ covered: 3, total: 6 });
    expect(r.subgraphs!.players.enumValues).toMatchObject({ covered: 1, total: 1 });
    expect(r.subgraphs!.clubs.enumValues).toMatchObject({ covered: 1, total: 2 });
    expect(r.subgraphs!.clubs.inputFields.total).toBe(0);
    expect(r.summary.fields.total).toBe(9);
  });

  it("gates one subgraph, every subgraph, or the whole schema", () => {
    expect(gate(r, { minFields: 55, subgraphs: ["clubs"] }).passed).toBe(true);
    const all = gate(r, { minFields: 55, subgraphs: ["*"] });
    expect(all.passed).toBe(false);
    expect(all.failures[0]).toMatch(/^\[players\] field coverage 50%/);
    expect(gate(r, { minFields: 55, subgraphs: ["billing"] }).failures[0]).toMatch(/not in the report/);
  });

  it("diffs per subgraph and scopes lost coverage to the gated subgraphs", () => {
    const head = computeCoverage(supergraph, [{ document: `{ clubs { id name } }` }]);
    const d = diffReports(r, head);
    expect(d.subgraphs!.players.fields).toBe(-33.33);
    expect(d.subgraphs!.clubs.fields).toBe(-20);
    expect(d.lostCoverage).toEqual(["Player", "Player.id", "PlayerFilter.surface", "Query.players", "Query.players(filter)", "Surface.CLAY"]);
    const clubsOnly = gate(head, { base: r, subgraphs: ["clubs"] });
    expect(clubsOnly.failures.at(-1)).toBe("lost coverage on: Player, Player.id, Surface.CLAY");
    expect(clubsOnly.failures.some((f) => f.startsWith("[clubs] fields coverage dropped by 20 points"))).toBe(true);
    expect(clubsOnly.failures.some((f) => f.includes("inputFields"))).toBe(false);
    expect(gate(head, { base: r, subgraphs: ["players"] }).passed).toBe(false);
  });

  it("keeps attribution and recomputes subgraph summaries on merge", () => {
    const other = computeCoverage(supergraph, [{ document: `mutation { renamePlayer(id: "1", name: "x") { id } }` }]);
    const m = mergeReports([r, other]);
    expect(m.types.Mutation.fields.renamePlayer.graphs).toEqual(["players"]);
    expect(m.subgraphs!.players.fields.covered).toBe(4);
  });
});

describe("subgraph SDL attribution", () => {
  it("reads ownership from one SDL per subgraph, skipping external fields and federation internals", () => {
    const m = subgraphsFromSdls({ clubs: clubsSdl, players: playersSdl });
    expect(m.names).toEqual(["clubs", "players"]);
    expect(m.elements.get("Club.name")).toEqual(["clubs"]);
    expect(m.elements.get("Club.id")).toEqual(["clubs", "players"]);
    expect(m.elements.get("Player.rating")).toEqual(["clubs"]);
    expect(m.elements.get("Surface.HARD")).toEqual(["clubs"]);
    expect(m.elements.get("PlayerFilter.surface")).toEqual(["players"]);
    expect(m.elements.has("Query._service")).toBe(false);
    expect(m.elements.has("_Service")).toBe(false);
  });

  it("attributes a plain API schema through subgraphSdls", () => {
    const api = /* GraphQL */ `
      enum Surface { CLAY HARD }
      input PlayerFilter { clubId: ID, surface: Surface }
      type Club { id: ID!, name: String!, players: [Player!]! }
      type Player { id: ID!, name: String!, rating: Float }
      type Query { clubs: [Club!]!, players(filter: PlayerFilter): [Player!]! }
      type Mutation { renamePlayer(id: ID!, name: String!): Player! }
    `;
    const r = computeCoverage(api, [{ document: `{ clubs { id name } }` }], { subgraphSdls: { clubs: clubsSdl, players: playersSdl } });
    expect(r.subgraphs!.clubs.fields).toMatchObject({ covered: 3, total: 5 });
    expect(r.subgraphs!.players.fields).toMatchObject({ covered: 1, total: 6 });
    expect(r.types.Query.fields.players.graphs).toEqual(["players"]);
  });

  it("reports no subgraphs for an ordinary schema", () => {
    const r = computeCoverage(`type Query { a: Int }`, []);
    expect(r.subgraphs).toBeUndefined();
    expect(r.types.Query.graphs).toBeUndefined();
  });
});
