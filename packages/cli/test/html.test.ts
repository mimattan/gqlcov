import { describe, expect, it } from "vitest";
import { buildSchema } from "graphql";
import { applyUsage, computeCoverage, type CoverageReport } from "@gqlcov/core";
import { renderHtml } from "../src/html.js";

const sdl = /* GraphQL */ `
  enum Surface { CLAY HARD }
  enum Status { OPEN CLOSED }
  interface Node { id: ID! }
  type Court implements Node { id: ID!, status: Status!, name(upper: Boolean): String }
  type CompetitionQueries { list: [Court!]!, get(id: ID!): Court }
  type LiveSubscriptions { ticks: Int }
  input CourtInput { name: String!, surface: Surface, note: String, ok: Boolean, tags: [String] }
  type Query { competition: CompetitionQueries, courts: [Court!]!, node(id: ID!): Node, hidden: Int }
  type Mutation { addCourt(input: CourtInput!): Court }
  type Subscription { live: LiveSubscriptions }
`;
const schema = buildSchema(sdl);
const ops = [
  { document: `query Comp { competition { list { id status name(upper: true) } } node(id: "1") { id } }`, responseEnums: { Status: ["OPEN"] }, source: "competition" },
  { document: `mutation Add { addCourt(input: { name: "a", surface: CLAY, note: null, ok: true }) { id } }`, source: "add court" },
  { document: `mutation Add { addCourt(input: { name: "b", ok: false }) { id } }`, source: "add court twice" },
  { document: `{ nope }` },
];

const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));

describe("renderHtml", () => {
  const report = computeCoverage(schema, ops, {
    exclude: ["Query.hidden"],
    run: { sha: "0123456789abcdef", branch: "main" },
    subgraphSdls: { courts: `type Court { id: ID!, status: Status! } enum Status { OPEN CLOSED } type Query { courts: [Court!]! }`, ops: `type Mutation { addCourt(input: CourtInput!): Court } input CourtInput { name: String! }` },
  });
  applyUsage(report, { source: "apollo g@current", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z", fields: { "Query.courts": 12_000, "Court.id": 5, "Court.status": 0, "Query.gone": 1, "CourtInput.tags": 40, "CourtInput.name": 2, "Surface.HARD": 3, "Status.OPEN": 8 } });
  const html = renderHtml(report, schema);

  it("shows run metadata, operation counts and every ledger number", () => {
    expect(html).toContain("main &nbsp;/&nbsp; commit 0123456789 &nbsp;/&nbsp; schema");
    expect(html).toContain("<b>3</b> operations captured: 1 queries, 2 mutations, 0 subscriptions, <b>1 invalid</b>.");
    for (const label of ["Output fields", "Arguments", "Input fields", "Optional input fields, both states", "Enum values", "Enum values in responses", "Types", "Production fields tested"]) expect(html).toContain(`<span class="ledger-label">${label}<small>`);
  });

  it("groups namespace root fields, keeps the rest as direct fields, and skips excluded root fields", () => {
    const query = between(html, "<h2>Query", "</section>");
    expect(query).toContain("Grouped by namespace");
    expect(query).toContain("Query.competition");
    expect(query).toContain("Query (direct fields)");
    expect(query).not.toContain('data-n="hidden"');
    const sub = between(html, "<h2>Subscription", "</section>");
    expect(sub).toContain("Subscription.live");
    expect(sub).not.toContain("direct fields");
    const mutation = between(html, "<h2>Mutation", "</section>");
    expect(mutation).not.toContain("Grouped by namespace");
  });

  it("marks arguments, production traffic and interfaces", () => {
    expect(html).toMatch(/<span class="on" title="1 hits: competition">upper<\/span>/);
    expect(html).toMatch(/<span class="off" title="0 hits">id<\/span>/);
    expect(html).toContain('<span class="prod risk" title="production requests in the usage window">12k in prod</span>');
    expect(html).toContain('<span class="prod" title="production requests in the usage window">5 in prod</span>');
    expect(html).toContain("no prod traffic");
    expect(html).toContain('<span class="kind">interface</span>Node');
  });

  it("shows input fields as never sent, sent only, or sent and omitted, with nulls and required marks", () => {
    const input = between(html, 'data-n="courtinput"', "</details>");
    expect(input).toContain(`<li class="on" data-n="name" data-g="ops" data-t="add court\nadd court twice"><span class="fname">name<span class='req'>!</span></span><span class="hits"><span class="by" title="Covered by: add court, add court twice">add court +1</span><span class="prod" title="production requests in the usage window">2 in prod</span>sent 2</span>`);
    expect(input).toContain(`<li class="on" data-n="note" data-g="ops" data-t="add court"><span class="fname">note</span><span class="hits"><span class="by" title="Covered by: add court">add court</span>sent 1, omitted 1, null 1</span>`);
    expect(input).toContain(`<li class="half" data-n="ok" data-g="ops" data-t="add court\nadd court twice">`);
    expect(input).toContain(`<li class="off" data-n="tags" data-g="ops"><span class="fname">tags</span><span class="hits"><span class="prod risk" title="production requests in the usage window">40 in prod</span>never sent</span>`);
  });

  it("scores input enums on values sent and output-only enums on values returned", () => {
    expect(html).toContain('<span class="kind">enum</span>Surface');
    expect(html).toContain('<span class="kind">out enum</span>Status');
    expect(html).toMatch(/data-n="open"[^>]*><span class="fname">OPEN<\/span><span class="hits">in 1 responses<\/span>/);
    expect(html).toMatch(/data-n="closed"[^>]*><span class="fname">CLOSED<\/span><span class="hits">not seen in responses<\/span>/);
    expect(html).toMatch(/data-n="clay" data-t="add court"><span class="fname">CLAY<\/span><span class="hits"><span class="by"[^>]*>add court<\/span>sent 1<\/span>/);
    expect(html).toMatch(/data-n="hard"><span class="fname">HARD<\/span><span class="hits"><span class="prod risk"[^>]*>3 in prod<\/span>never sent<\/span>/);
  });

  it("renders the production usage section with every list", () => {
    const usage = between(html, '<section class="usage">', "</section>");
    expect(usage).toContain("apollo g@current, 2026-10-01 to 2026-10-31");
    expect(usage).toContain('<span class="prod risk">12k requests</span>never tested');
    expect(usage).toContain("Tested, no production traffic");
    expect(usage).toContain("No traffic and no test: deprecation candidates");
    expect(usage).toContain("In usage data but not in the schema");
  });

  it("shows production traffic on input fields and input enum values", () => {
    expect(html).toContain(`<span class="ledger-label">Production inputs sent by a test<small>`);
    const input = between(html, 'data-n="courtinput"', "</details>");
    expect(input).toContain('<span class="prod risk" title="production requests in the usage window">40 in prod</span>never sent');
    expect(input).toContain('<span class="prod" title="production requests in the usage window">2 in prod</span>sent 2');
    expect(html).toMatch(/data-n="open"[^>]*><span class="fname">OPEN<\/span><span class="hits">in 1 responses<\/span>/); // output-only: no traffic badge
    const usage = between(html, '<section class="usage">', "</section>");
    expect(usage).toContain('CourtInput.tags <span class="kind">input</span>');
    expect(usage).toContain('Surface.HARD <span class="kind">enum value</span>');
    expect(usage).toContain("3 input fields and enum values had traffic; a test sent 1 of them.");
  });

  it("renders the subgraph table and filter", () => {
    expect(html).toContain('<button type="button" class="sg-pick" data-sg="courts">courts</button>');
    expect(html).toContain('<option value="ops">ops</option>');
    expect(html).toContain('data-g="courts"');
  });

  it("labels rows with the tests that covered them and lists every test", () => {
    expect(html).toContain(`data-t="add court\nadd court twice\ncompetition"`);
    expect(html).toContain(`<span class="by" title="Covered by: add court, add court twice, competition">add court +2</span>`);
    expect(html).toContain(`<span class="by" title="Covered by: add court">add court</span>`);
    expect(html).toContain(`title="1 hits: competition">upper</span>`);
    expect(html).toContain(`title="0 hits">id</span>`);
    const tests = between(html, '<section class="tests">', "</section>");
    expect(tests).toContain('<h2>Tests <span class="h2-note">3</span></h2>');
    expect(tests).toMatch(/<details class="row aux redundant"><summary><div class="sum"><span class="rname">add court twice<\/span><span class="hits">1 ops, \d+ covered, 0 only here/);
    expect(tests).toContain("Covers nothing the other tests do not.");
    expect(tests).toContain('<span class="fname">CourtInput.surface</span><span class="hits">only this test</span>');
  });

  it("shows response numbers, fields that never came back, and interface implementations", () => {
    const html = renderHtml(
      computeCoverage(schema, [
        { document: `{ competition { list { id } } node(id: "1") { __typename id } }`, responseValues: { "Query.competition": ["value"], "CompetitionQueries.list": ["empty"], "Query.node": ["value"], "Node.id": ["value"] }, responseTypes: { Node: ["Court"] } },
        { document: `{ courts { name } }`, responseValues: { "Query.courts": ["value"], "Court.name": ["null", "empty"] } },
      ]),
      schema,
    );
    expect(html).toContain(`<span class="ledger-label">Fields that returned a value<small>`);
    expect(html).toContain(`<span class="ledger-label">Possible types returned<small>`);
    expect(html).toContain(`<span class="noval" title="requested, but every response had it as an empty list">always empty</span>`);
    expect(html).toContain(`<span class="noval" title="requested, but every response had it as null or an empty list">null or empty</span>`);
    const abstract = between(html, "<h2>Interfaces and unions", "</section>");
    expect(abstract).toContain('<span class="kind">interface</span>Node');
    expect(abstract).toContain('<li class="on" data-n="court"><span class="fname">Court</span><span class="hits">in 1 responses</span></li>');
  });

  it("says when a field was only ever null, and when no __typename was seen", () => {
    const s = `interface N { id: ID! } type A implements N { id: ID!, x: Int } type B implements N { id: ID! } union U = A type Query { n: N, u: U, a: A }`;
    const r = computeCoverage(s, [{ document: `{ a { x } n { __typename } }`, responseValues: { "Query.a": ["value"], "A.x": ["null"] }, responseTypes: { N: ["A"] } }]);
    const out = renderHtml(r);
    expect(out).toContain('<li class="off" data-n="b"><span class="fname">B</span><span class="hits">never returned</span></li>');
    delete r.abstractTypes; // a report from before the interface and union table
    expect(renderHtml(r)).toContain('<h2>Interfaces and unions <span class="h2-note">0</span></h2>');
    expect(out).toContain(`<span class="noval" title="requested, but every response had it as null">always null</span>`);
    expect(out).toContain('<span class="kind">union</span>U');
    expect(out).toContain('<span class="hits">no __typename seen</span>');
  });

  it("renders a bare report: no schema, no operations, no usage or subgraphs, older enum format", () => {
    const bare = computeCoverage(`enum E { A } type Thing { x: Int } type Query { a(e: E): Int, b: Int, t: [Thing] }`, [], { exclude: ["Thing.*"] }) as CoverageReport;
    delete (bare.enums.E as Partial<typeof bare.enums.E>).input;
    delete (bare.enums.E.values.A as Partial<typeof bare.enums.E.values.A>).observed;
    delete (bare.summary as Partial<typeof bare.summary>).enumValuesObserved;
    const out = renderHtml(bare);
    expect(out).toContain("<b>No operations captured.</b>");
    expect(out).toContain('<p class="empty">No operations in this run.</p>');
    expect(out).not.toContain("Enum values in responses");
    expect(out).not.toContain("Production fields tested");
    expect(out).not.toContain('<section class="subgraphs">');
    expect(out).not.toContain('<select id="sg"');
    expect(out).not.toContain("Grouped by namespace");
    expect(out).not.toContain('<section class="tests">');
    expect(out).not.toContain('class="by"');
    expect(out).not.toContain("Interfaces and unions");
    expect(out).not.toContain("Fields that returned a value");
    expect(out).toMatch(/<span class="kind">enum<\/span>E/);
    expect(out).toMatch(/Thing<\/span><span class="mini">.*?width:100%.*?0\/0/); // a type with every field excluded
    expect(out).toMatch(/schema [0-9a-f]+ &nbsp;\/&nbsp; generated/);
    expect(out).toContain("<b>No operations captured.</b>");
  });

  it("says when every field with traffic is tested, and leaves out empty lists and a missing window", () => {
    const r = computeCoverage(`type Query { a: Int }`, [{ document: `{ a }` }], { usage: { fields: { "Query.a": 3 } } });
    const usage = between(renderHtml(r), '<section class="usage">', "</section>");
    expect(usage).toContain("Every field with production traffic was requested by a test.");
    expect(usage).toContain('<h2>Production usage <span class="h2-note"></span></h2>');
    expect(usage).not.toContain("<details");
  });
});
