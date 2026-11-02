import { describe, expect, it } from "vitest";
import { GraphQLEnumType, GraphQLInt, GraphQLObjectType, GraphQLSchema, parse } from "graphql";
import { computeCoverage, diffReports, gate, mergeReports, subgraphsFromSdls, subgraphsFromSupergraph, summariseSubgraphs } from "../src/index.js";

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

describe("unusual supergraph and subgraph shapes", () => {
  const odd = /* GraphQL */ `
    directive @join__graph(name: String!, url: String!) on ENUM_VALUE
    directive @join__type(graph: join__Graph!, key: String) repeatable on OBJECT | INTERFACE | ENUM | INPUT_OBJECT | SCALAR
    directive @join__field(graph: join__Graph, external: Boolean, type: String) repeatable on FIELD_DEFINITION | INPUT_FIELD_DEFINITION
    directive @join__enumValue(graph: join__Graph!) repeatable on ENUM_VALUE
    directive @tag(name: String!) repeatable on OBJECT | FIELD_DEFINITION
    enum join__Graph { A @join__graph(name: "alpha", url: "x") B }
    enum Mood @join__type(graph: A) { HAPPY SAD @join__enumValue(graph: A) }
    type Plain { x: Int }
    type Thing @tag(name: "t") @join__type(graph: A) @join__type(graph: B) {
      id: ID!
      ext: Int @join__field(graph: B, external: true)
      nograph: Int @join__field(type: "Int")
      nullgraph: Int @join__field(graph: null)
      typo: Int @join__field(graph: C)
    }
    type Query @join__type(graph: A) { thing: Thing, plain: Plain, mood: Mood }
  `;

  it("falls back sensibly for every shape", () => {
    const r = computeCoverage(odd, []);
    expect(Object.keys(r.subgraphs!)).toEqual(["B", "alpha"]); // B has no @join__graph: its enum name is used
    expect(r.types.Thing.graphs).toEqual(["B", "alpha"]);
    expect(r.types.Thing.fields.ext.graphs).toEqual(["B", "alpha"]); // only external: every subgraph of the type
    expect(r.types.Thing.fields.nograph.graphs).toEqual(["B", "alpha"]);
    expect(r.types.Thing.fields.nullgraph.graphs).toEqual(["B", "alpha"]);
    expect(r.types.Thing.fields.typo.graphs).toEqual(["C"]);
    expect(r.types.Plain.graphs).toBeUndefined(); // no @join__type
    expect(r.types.Plain.fields.x.graphs).toBeUndefined();
    expect(r.enums.Mood.values.HAPPY.graphs).toEqual(["alpha"]);
    expect(r.subgraphs!.alpha.fields.total).toBe(7); // Thing x4 (typo belongs to C), Query x3; Plain.x is in no subgraph
  });

  it("lets fields without syntax nodes inherit their type's subgraphs", () => {
    const graph = new GraphQLEnumType({ name: "join__Graph", values: { ONLY: {} } });
    const def = (sdl: string) => parse(sdl).definitions[0] as never;
    const Thing = new GraphQLObjectType({ name: "Thing", astNode: def(`type Thing @join__type(graph: ONLY)`), fields: { x: { type: GraphQLInt } } });
    const Query = new GraphQLObjectType({ name: "Query", astNode: def(`type Query @join__type(graph: ONLY)`), fields: { thing: { type: Thing }, g: { type: graph } } });
    const m = subgraphsFromSupergraph(new GraphQLSchema({ query: Query }))!;
    expect(m.names).toEqual(["ONLY"]);
    expect(m.elements.get("Thing.x")).toEqual(["ONLY"]);
  });

  it("reads federation__external and ignores scalars, unions and directives in subgraph SDLs", () => {
    const m = subgraphsFromSdls({
      a: `scalar Date union U = T directive @x on FIELD type T { id: ID!, b: Int @federation__external } type Query { t: T }`,
    });
    expect(m.elements.get("T.b")).toBeUndefined();
    expect(m.elements.has("Date")).toBe(false);
  });

  it("leaves elements no subgraph SDL defines unattributed and out of every subgraph", () => {
    const api = `enum E { X Y } input I { a: Int, b: Int } type T { id: ID!, extra: Int } type Orphan { z: Int } type Query { t(i: I): T, e: E, o: Orphan }`;
    const r = computeCoverage(api, [], { subgraphSdls: { a: `enum E { X } input I { a: Int } type T { id: ID! } type Query { t(i: I): T, e: E }` } });
    expect(r.types.T.fields.extra.graphs).toEqual(["a"]); // falls back to its type
    expect(r.inputTypes.I.fields.b.graphs).toEqual(["a"]);
    expect(r.enums.E.values.Y.graphs).toEqual(["a"]);
    expect(r.types.Orphan.fields.z.graphs).toBeUndefined();
    expect(r.subgraphs!.a.fields.total).toBe(5); // T.id, T.extra, Query.t, Query.e, Query.o
  });

  it("summarises no subgraphs for a report without attribution, and gates wildcard and unattributed losses", () => {
    expect(summariseSubgraphs(computeCoverage(`type Query { a: Int }`, []))).toEqual({});
    const api = `type Query { a: Int, b: Int, orphan: Int }`;
    const sdls = { s: `type Query { a: Int, b: Int }` };
    const base = computeCoverage(api, [{ document: `{ a orphan }` }], { subgraphSdls: sdls });
    const head = computeCoverage(api, [], { subgraphSdls: sdls });
    // Query.orphan falls back to Query's graphs ["s"]; delete them to model an element no subgraph owns.
    delete head.types.Query.fields.orphan.graphs;
    expect(gate(head, { base, subgraphs: ["*"] }).failures.at(-1)).toBe("lost coverage on: Query, Query.a, Query.orphan");
    expect(gate(head, { base, subgraphs: ["s"] }).failures.at(-1)).toBe("lost coverage on: Query, Query.a");
  });
});
