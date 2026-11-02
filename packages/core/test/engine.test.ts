import { describe, expect, it } from "vitest";
import { GraphQLEnumType, GraphQLInt, GraphQLObjectType, GraphQLSchema, Kind, parse, type DocumentNode } from "graphql";
import { computeCoverage, diffReports, gate, mergeReports, parsePersistedManifest, schemaLineMap, summarise, summariseResponses, toLcov, uncovered, type CapturedOperation, type CoverageReport } from "../src/index.js";

const sdl = /* GraphQL */ `
  enum Surface { CLAY HARD GRASS @deprecated(reason: "gone") }
  enum Level { LOW HIGH }
  input Range { min: Int = 0, max: Int }
  input Filter { surface: Surface, range: Range, ids: [ID!], level: Level, secret: String }
  interface Node { id: ID! }
  type Court implements Node { id: ID!, surface: Surface!, name(upper: Boolean, legacy: Boolean @deprecated(reason: "x")): String }
  type Club implements Node { id: ID!, courts: [Court!]! }
  union Thing = Court | Club
  type Query { courts(filter: Filter): [Court!]!, things: [Thing!]!, node(id: ID!): Node, level: Level }
`;

describe("reading argument values", () => {
  it("does not count an input field's default as sent when a literal omits it", () => {
    const literal = computeCoverage(sdl, [{ document: `{ courts(filter: { range: { max: 3 } }) { id } }` }]);
    expect(literal.inputTypes.Range.fields.min).toMatchObject({ sent: 0, omitted: 1 });
    expect(literal.inputTypes.Range.fields.max).toMatchObject({ sent: 1, omitted: 0 });
  });

  it("counts literal enum values by name in a code-first schema with custom internal values", () => {
    const Color = new GraphQLEnumType({ name: "Color", values: { RED: { value: 1 }, BLUE: { value: 2 } } });
    const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: { paint: { type: GraphQLInt, args: { c: { type: Color } } } } }) });
    const r = computeCoverage(schema, [{ document: `{ paint(c: RED) }` }, { document: `query ($c: Color) { paint(c: $c) }`, variables: { c: "BLUE" } }]);
    expect(r.enums.Color.values).toMatchObject({ RED: { hits: 1 }, BLUE: { hits: 1 } });
  });

  it("substitutes variables inside literals and treats a missing one as an absent field", () => {
    const r = computeCoverage(sdl, [{ document: `query ($s: Surface, $m: Int) { courts(filter: { surface: $s, range: { max: $m } }) { id } }`, variables: { s: "HARD" } }]);
    expect(r.inputTypes.Filter.fields.surface.sent).toBe(1);
    expect(r.inputTypes.Range.fields.max).toMatchObject({ sent: 0, omitted: 1 });
    expect(r.enums.Surface.values.HARD.hits).toBe(1);
  });

  it("treats a bare value for a list as a list of one, and ignores values of the wrong shape", () => {
    const r = computeCoverage(sdl, [
      { document: `{ courts(filter: { ids: "7" }) { id } }` },
      { document: `query ($f: Filter) { courts(filter: $f) { id } }`, variables: { f: "not an object" } },
      { document: `query ($f: Filter) { courts(filter: $f) { id } }`, variables: { f: { surface: 3 } } },
    ]);
    expect(r.inputTypes.Filter.fields.ids.values).toMatchObject({ listOne: 1, typical: 1 }); // a list of one, and its item
    expect(r.inputTypes.Filter.hits).toBe(2); // the string was not walked as an object
    expect(Object.values(r.enums.Surface.values).every((v) => v.hits === 0)).toBe(true);
  });
});

describe("walking documents", () => {
  it("counts fragment type conditions, unions, interfaces, __typename and introspection without inventing fields", () => {
    const r = computeCoverage(sdl, [
      { document: `query T { things { __typename ...C ... on Club { id } } } fragment C on Court { name }` },
      { document: `{ __typename node(id: "1") { id } __schema { queryType { name } } }` },
    ]);
    expect(r.types.Court.hits).toBe(2); // fragment definition + Court.name
    expect(r.types.Court.fields.name.hits).toBe(1);
    expect(r.types.Club.fields.id.hits).toBe(1);
    expect(r.types.Node.fields.id.hits).toBe(1);
    expect(r.types.Query.fields.things.hits).toBe(1);
    expect(r.types.__Schema).toBeUndefined();
    expect(r.summary.fields.covered).toBe(5);
  });

  it("skips deprecated arguments, excluded types, input types, fields and enum values", () => {
    const r = computeCoverage(sdl, [
      { document: `{ courts(filter: { secret: "x", level: HIGH }) { name(legacy: true, upper: true) } }` },
      { document: `{ level }`, responseEnums: { Level: ["LOW"], Surface: ["CLAY"] } },
    ], { exclude: ["Filter.secret", "Level", "Club", "Surface.HARD"] });
    expect(r.types.Court.fields.name.args.legacy).toBeUndefined();
    expect(r.types.Court.fields.name.args.upper.hits).toBe(1);
    expect(r.inputTypes.Filter.fields.secret).toBeUndefined();
    expect(r.enums.Level).toBeUndefined();
    expect(r.types.Club).toBeUndefined();
    expect(Object.keys(r.enums.Surface.values)).toEqual(["CLAY"]);
    expect(r.enums.Surface.values.CLAY.observed).toBe(1);
  });

  it("counts captures without a document as unresolved and keeps run info", () => {
    const r = computeCoverage(sdl, [{}], { run: { sha: "abc", branch: "main" } });
    expect(r.operations).toMatchObject({ total: 0, unresolved: 1 });
    expect(r.run).toEqual({ sha: "abc", branch: "main" });
  });

  it("counts operations only once when a document holds several and none is named", () => {
    const r = computeCoverage(sdl, [{ document: `query A { level } query B { things { __typename } }`, operationName: "B" }]);
    expect(r.operations.named).toEqual({ B: 1 });
    expect(r.types.Query.fields.level.hits).toBe(0);
  });
});

describe("summaries of older reports", () => {
  it("counts enums without input/output flags as input, as reports before the split did", () => {
    const r = computeCoverage(sdl, [{ document: `{ courts(filter: { level: LOW }) { id } }` }]);
    const legacy = structuredClone(r) as CoverageReport;
    for (const e of Object.values(legacy.enums)) {
      delete (e as Partial<typeof e>).input;
      delete (e as Partial<typeof e>).output;
    }
    const s = summarise(legacy);
    expect(s.enumValues).toMatchObject({ covered: 1, total: 4 });
    expect(s.enumValuesObserved.total).toBe(0);
  });

  it("merges reports without observed counts or the unresolved counter", () => {
    const a = computeCoverage(sdl, [{ document: `{ level }`, responseEnums: { Level: ["LOW"] } }]);
    const b = computeCoverage(sdl, [{}]);
    for (const r of [a, b]) for (const v of Object.values(r.enums.Level.values)) delete (v as Partial<typeof v>).observed;
    const m = mergeReports([a, b]);
    expect(m.enums.Level.values.LOW.observed).toBe(0);
    expect(m.operations.unresolved).toBe(1);
  });
});

describe("merging shards", () => {
  it("adds named operations from later shards and skips elements a shard did not include", () => {
    const narrow = computeCoverage(sdl, [{ document: `query A { level }` }], { exclude: ["Club", "Court.name", "Range", "Filter.ids", "Level", "Surface.HARD"] });
    const wide = computeCoverage(sdl, [
      { document: `query B { things { ... on Club { id } } courts(filter: { ids: ["1", "2"], range: { max: 1 }, surface: HARD }) { name } level }`, responseEnums: { Surface: ["HARD"] } },
    ]);
    const m = mergeReports([narrow, wide]);
    expect(m.operations.named).toEqual({ A: 1, B: 1 });
    expect(m.types.Club).toBeUndefined();
    expect(m.types.Court.fields.name).toBeUndefined();
    expect(m.inputTypes.Filter.fields.ids).toBeUndefined();
    expect(m.enums.Level).toBeUndefined();
    expect(m.enums.Surface.values.HARD).toBeUndefined();
    expect(m.types.Query.fields.courts.hits).toBe(1);
  });

  it("refuses an empty list and reports with different schemas", () => {
    expect(() => mergeReports([])).toThrow("no reports given");
    expect(() => mergeReports([computeCoverage(sdl, []), computeCoverage(`type Query { x: Int }`, [])])).toThrow("schema hashes differ");
  });
});

describe("diff and gate", () => {
  it("lists schema additions and removals", () => {
    const base = computeCoverage(`type Query { a: Int, gone: Int }`, []);
    const head = computeCoverage(`type Query { a: Int, added: Int }`, []);
    const d = diffReports(base, head);
    expect(d.schemaAdded).toEqual(["Query.added"]);
    expect(d.schemaRemoved).toEqual(["Query.gone"]);
  });

  it("explains each threshold it fails", () => {
    const r = computeCoverage(sdl, [{ document: `{ level }` }]);
    const g = gate(r, { minFields: 50, minInputFields: 50, minEnumValues: 50 });
    expect(g.failures).toEqual([
      `field coverage ${r.summary.fields.percent}% is below the minimum 50%`,
      "input-field coverage 0% is below the minimum 50%",
      "enum-value coverage 0% is below the minimum 50%",
    ]);
  });

  it("shortens long lists of lost coverage and untested production fields", () => {
    const fields = Array.from({ length: 25 }, (_, i) => `f${i}: Int`).join(" ");
    const s = `type Query { ${fields} }`;
    const all = `{ ${Array.from({ length: 25 }, (_, i) => `f${i}`).join(" ")} }`;
    const base = computeCoverage(s, [{ document: all }]);
    const head = computeCoverage(s, [], { usage: { fields: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Query.f${i}`, 1])) } });
    const g = gate(head, { base, minUsedFields: 50 });
    expect(g.failures.find((f) => f.startsWith("lost coverage"))).toMatch(/and 6 more$/);
    expect(g.failures.find((f) => f.includes("production traffic"))).toMatch(/\(12 untested: Query.f0, Query.f1, Query.f10, Query.f11, Query.f2, .*, \.\.\.\)$/);
  });

  it("fails clearly when subgraphs are asked for and the report has none", () => {
    const r = computeCoverage(sdl, []);
    expect(gate(r, { subgraphs: ["*"] }).failures).toEqual(["every subgraph was asked for, but the report has no subgraph attribution"]);
    expect(gate(r, { subgraphs: ["clubs"] }).failures).toEqual(['subgraph "clubs" is not in the report (no subgraph attribution)']);
  });
});

describe("persisted manifests", () => {
  it("accepts hash and sha256Hash ids and document bodies, and skips junk entries", () => {
    const m = parsePersistedManifest([null, "x", { hash: "h", document: "{ a }" }, { sha256Hash: "s", query: "{ b }" }, { id: 1, body: "{ c }" }]);
    expect([...m]).toEqual([["h", "{ a }"], ["s", "{ b }"]]);
  });
});

describe("export", () => {
  it("accepts a DocumentNode and skips elements without a known line", () => {
    const withLines = schemaLineMap(parse(sdl));
    expect(withLines.get("Court.name(upper)")).toBe(7);
    const noLines = parse(sdl, { noLocation: true });
    expect(schemaLineMap(noLines).get("Court.name")).toBe(0);
    const r = computeCoverage(sdl, [{ document: `{ level }` }]);
    const lcov = toLcov(r, noLines, "s.graphql");
    for (const counter of ["FNF:0", "LF:0", "BRF:0"]) expect(lcov).toContain(counter);
    expect(lcov).not.toMatch(/^DA:/m);
  });

  it("tolerates hand-built definitions without fields, arguments or values", () => {
    const name = (value: string) => ({ kind: Kind.NAME, value });
    const doc = {
      kind: Kind.DOCUMENT,
      definitions: [
        { kind: Kind.OBJECT_TYPE_DEFINITION, name: name("Empty") },
        { kind: Kind.OBJECT_TYPE_DEFINITION, name: name("Q"), fields: [{ kind: Kind.FIELD_DEFINITION, name: name("a"), type: { kind: Kind.NAMED_TYPE, name: name("Int") } }] },
        { kind: Kind.INPUT_OBJECT_TYPE_DEFINITION, name: name("In") },
        { kind: Kind.ENUM_TYPE_DEFINITION, name: name("E") },
      ],
    } as unknown as DocumentNode;
    expect([...schemaLineMap(doc)]).toEqual([["Q.a", 0]]);
  });
});

describe("gate --require", () => {
  const s = /* GraphQL */ `
    enum Status { OPEN CLOSED }
    enum Currency { EUR USD }
    input PayInput { amount: Int!, currency: Currency }
    type Club { id: ID!, status: Status }
    type Query { club(id: ID!): Club, payments: [Int], paymentLink: String }
    type Mutation { pay(input: PayInput!): Boolean, refund(id: ID!): Boolean }
  `;
  const r = computeCoverage(s, [
    { document: `mutation { pay(input: { amount: 1, currency: EUR }) }` },
    { document: `{ club(id: "1") { status } }`, responseEnums: { Status: ["OPEN"] } },
  ]);

  it("passes when every matching element is covered", () => {
    expect(gate(r, { require: ["Mutation.pay", "Mutation.pay(input)", "PayInput.*", "Status.OPEN", "Club"] }).passed).toBe(true);
  });

  it("names what is missing per pattern, counting output-only enum values by what responses returned", () => {
    const g = gate(r, { require: ["Mutation.*", "Query.payment*", "Currency.*", "Status.*", "**"] });
    expect(g.failures).toEqual([
      'required "Mutation.*": 1 of 2 not covered: Mutation.refund',
      'required "Query.payment*": 2 of 2 not covered: Query.paymentLink, Query.payments',
      'required "Currency.*": 1 of 2 not covered: Currency.USD',
      'required "Status.*": 1 of 2 not covered: Status.CLOSED',
      expect.stringMatching(/^required "\*\*": \d+ of \d+ not covered: Club.id, Currency.USD, /),
    ]);
  });

  it("fails a pattern that matches nothing, and shortens long lists", () => {
    expect(gate(r, { require: ["Mutaton.*"] }).failures).toEqual(['required "Mutaton.*" matches nothing in the report (excluded and deprecated elements are not in it)']);
    const wide = computeCoverage(`type Query { ${Array.from({ length: 25 }, (_, i) => `f${i}: Int`).join(" ")} }`, []);
    expect(gate(wide, { require: ["Query.*"] }).failures[0]).toMatch(/^required "Query\.\*": 25 of 25 not covered: .* and 5 more$/);
  });
});

describe("response-aware coverage", () => {
  const rs = /* GraphQL */ `
    interface Node { id: ID! }
    type Court implements Node { id: ID!, name: String, tags: [String!]! }
    type Club implements Node { id: ID!, courts: [Court!]! }
    type Hidden implements Node { id: ID! }
    union Thing = Court | Club
    type Query { node(id: ID!): Node, things: [Thing!]!, court: Court }
  `;
  const ops: CapturedOperation[] = [
    { document: `{ node(id: "1") { __typename id } court { name tags } }`, responseValues: { "Query.node": ["value" as const], "Node.id": ["value" as const], "Query.court": ["value" as const], "Court.name": ["null" as const], "Court.tags": ["empty" as const] }, responseTypes: { Node: ["Club", "Ghost"] } },
    { document: `{ court { name } }`, responseValues: { "Query.court": ["value" as const], "Court.name": ["null" as const, "null" as const], "Gone.x": ["value" as const] }, responseTypes: { Unknown: ["X"] } },
    { document: `{ things { __typename } }` },
  ];

  it("counts outcomes per field and concrete types per interface or union", () => {
    const r = computeCoverage(rs, ops, { exclude: ["Hidden"] });
    expect(r.operations.responses).toBe(2);
    expect(r.types.Court.fields.name.returned).toEqual({ value: 0, null: 2, empty: 0 });
    expect(r.types.Court.fields.tags.returned).toEqual({ value: 0, null: 0, empty: 1 });
    expect(r.types.Query.fields.things.returned).toBeUndefined(); // that capture had no response data
    expect(r.abstractTypes!.Node).toEqual({ kind: "INTERFACE", seen: 1, possible: { Court: 0, Club: 1 } }); // Hidden excluded, Ghost unknown
    expect(r.abstractTypes!.Thing).toEqual({ kind: "UNION", seen: 0, possible: { Court: 0, Club: 0 } });
    expect(r.summary.fieldsReturned).toMatchObject({ covered: 3, total: 5 }); // node, Node.id and court came back; name and tags did not
    expect(r.summary.possibleTypes).toMatchObject({ covered: 1, total: 2 }); // Thing was never seen, so it does not count
    const u = uncovered(r);
    expect(u.neverReturned).toEqual(["Court.name", "Court.tags"]);
    expect(u.possibleTypes).toEqual(["Node.Court"]);
  });

  it("leaves the numbers out without response data, and never gates them", () => {
    const plain = computeCoverage(rs, [{ document: `{ court { name } }` }]);
    expect(plain.summary.fieldsReturned).toBeUndefined();
    expect(plain.summary.possibleTypes).toBeUndefined();
    expect(uncovered(plain).neverReturned).toEqual([]);
    const better = computeCoverage(rs, [{ document: `{ court { name } }`, responseValues: { "Court.name": ["value"] } }]);
    const worse = computeCoverage(rs, [{ document: `{ court { name } }`, responseValues: { "Court.name": ["null"] } }]);
    expect(gate(worse, { base: better }).passed).toBe(true);
  });

  it("adds outcomes, types and response counts on merge, skipping what one shard excluded", () => {
    const a = computeCoverage(rs, ops.slice(0, 1));
    const b = computeCoverage(rs, [{ document: `{ court { name } }`, responseValues: { "Court.name": ["value"] }, responseTypes: { Node: ["Court"], Thing: ["Club"] } }], { exclude: ["Thing"] });
    const m = mergeReports([a, b, computeCoverage(rs, [])]);
    expect(m.operations.responses).toBe(2);
    expect(m.types.Court.fields.name.returned).toEqual({ value: 1, null: 1, empty: 0 });
    expect(m.abstractTypes!.Node.possible).toEqual({ Court: 1, Club: 1, Hidden: 0 });
    expect(m.summary.fieldsReturned!.covered).toBeGreaterThan(a.summary.fieldsReturned!.covered);
    expect(mergeReports([computeCoverage(rs, []), a]).operations.responses).toBe(1);
    const narrow = mergeReports([computeCoverage(rs, [], { exclude: ["Thing"] }), computeCoverage(rs, [{ document: `{ court { id } }`, responseTypes: { Thing: ["Court"] } }])]);
    expect(narrow.abstractTypes!.Thing).toBeUndefined();
  });

  it("works on older reports without the interface and union table", () => {
    const old = computeCoverage(rs, [{ document: `{ court { name } }`, responseValues: { "Court.name": ["value"] } }]);
    delete old.abstractTypes;
    summariseResponses(old);
    expect(old.summary.possibleTypes).toBeUndefined();
    expect(old.summary.fieldsReturned).toMatchObject({ covered: 1, total: 1 });
    const nothingBack = computeCoverage(rs, [{ document: `{ court { name } }`, responseValues: {} }]);
    expect(nothingBack.operations.responses).toBe(1);
    expect(nothingBack.summary.fieldsReturned).toBeUndefined();
    expect(uncovered(old).possibleTypes).toEqual([]);
    expect(mergeReports([old, old]).operations.responses).toBe(2);
  });
});
