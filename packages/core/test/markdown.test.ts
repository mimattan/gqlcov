import { describe, expect, it } from "vitest";
import { computeCoverage, fmtRequests, toMarkdown, type CoverageReport } from "../src/index.js";

const sdl = /* GraphQL */ `
  enum Surface { CLAY HARD }
  input Filter { surface: Surface }
  type Court { id: ID!, name: String }
  type Query { courts(filter: Filter): [Court!]!, court(id: ID!): Court }
`;
const sdls = { courts: `type Court { id: ID!, name: String } type Query { courts: [Court!]!, court(id: ID!): Court }` };

describe("toMarkdown", () => {
  it("summarises a single report with its untested elements and production risk", () => {
    const r = computeCoverage(sdl, [{ document: `{ courts { id } }` }, { document: `{ nope }` }, { persistedId: "x" }], {
      run: { sha: "0123456789abcdef" },
      subgraphSdls: sdls,
      usage: { fields: { "Query.court": 2_000_000, "Court.name": 5 } },
    });
    const md = toMarkdown(r);
    expect(md).toContain("1 operations (1 queries, 0 mutations, 0 subscriptions), 1 invalid, 1 unresolved persisted ids.");
    expect(md).toContain("| Metric | Coverage | Covered |");
    expect(md).toMatch(/\| Output fields \| 50% \| 2 of 4 \|/);
    expect(md).toContain("| Production fields tested | 0% | 0 of 2 |");
    expect(md).toContain("| courts | 50% | 100% | 100% |");
    expect(md).toContain("<details><summary>Untested output fields (2)</summary>\n\n- `Court.name`\n- `Query.court`\n\n</details>");
    expect(md).toContain("- `Query.court`: 2M requests");
    expect(md).toContain("<sub>gqlcov · commit 0123456789 · schema ");
    expect(md).not.toMatch(/\n{3,}/);
  });

  it("compares with a base report: changes, lost coverage, additions without a test, removals", () => {
    const base = computeCoverage(`${sdl} extend type Query { gone: Int }`, [{ document: `{ courts(filter: { surface: CLAY }) { id name } }` }], { subgraphSdls: sdls });
    const head = computeCoverage(`${sdl} extend type Query { added: Int, addedTested: Int }`, [{ document: `{ courts { id } court(id: "1") { id } addedTested }` }], { subgraphSdls: { ...sdls, extra: `type Query { added: Int }` } });
    const md = toMarkdown(head, base);
    expect(md).toContain("| Metric | Base | This change | Change |");
    expect(md).toMatch(/\| Output fields \| [\d.]+% \| [\d.]+% \| ▲ \+[\d.]+ \|/);
    expect(md).toMatch(/\| Input fields \| 100% \| 0% \| ▼ -100 \|/);
    expect(md).toMatch(/\| Types \| 100% \| 100% \| = \|/);
    expect(md).toMatch(/\| courts \| [\d.]+% \(▲ \+[\d.]+\) \| 100% \(=\) \| 100% \(=\) \|/);
    expect(md).toContain("| extra | 50% (new) | 100% (new) | 100% (new) |");
    expect(md).toContain("<summary>Lost coverage (");
    expect(md).toContain("- `Filter.surface`");
    expect(md).toContain("<details><summary>New in the schema, not tested (1)</summary>\n\n- `Query.added`");
    expect(md).toContain("<summary>Newly covered (");
    expect(md).toContain("<details><summary>Removed from the schema (1)</summary>\n\n- `Query.gone`");
    expect(md).not.toContain("Untested output fields");
  });

  it("handles older base reports, production usage on both sides, and long lists", () => {
    const fields = Array.from({ length: 60 }, (_, i) => `f${i}: Int`).join(" ");
    const s = `type Query { ${fields} }`;
    const base = computeCoverage(s, [{ document: `{ ${Array.from({ length: 60 }, (_, i) => `f${i}`).join(" ")} }` }], { usage: { fields: { "Query.f0": 1 } } }) as CoverageReport;
    delete (base.summary as Partial<typeof base.summary>).enumValuesObserved;
    const head = computeCoverage(s, [], { usage: { fields: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Query.f${i}`, 30 - i])) } });
    const md = toMarkdown(head, base);
    expect(md).toContain("| Enum values in responses | – | 100% | new |");
    expect(md).toContain("| Production fields tested | 100% | 0% | ▼ -100 |");
    expect(md).toContain("- … and 11 more\n\n</details>"); // 61 lost (60 fields + Query), 50 shown
    expect(md).toContain("<details><summary>Used in production, never tested (30)</summary>");
    expect(md).toContain("- … and 5 more");
    const noUsageBase = toMarkdown(head, computeCoverage(s, []));
    expect(noUsageBase).toContain("| Production fields tested | – | 0% | new |");
    const quiet = toMarkdown(computeCoverage(`type Query { a: Int }`, [{ document: `{ a }` }]));
    expect(quiet).not.toContain("<details>");
    expect(quiet).toMatch(/<sub>gqlcov · schema [0-9a-f]+<\/sub>/);
  });
});

describe("fmtRequests", () => {
  it("formats plain numbers, thousands and millions", () => {
    expect([fmtRequests(950), fmtRequests(9999), fmtRequests(15_400), fmtRequests(2_460_000)]).toEqual(["950", "9999", "15k", "2.5M"]);
  });
});
