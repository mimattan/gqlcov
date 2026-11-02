import { coveredPaths, diffReports, uncovered } from "./diff.js";
import type { CoverageReport, CoverageSummary, Ratio } from "./types.js";

/** Request counts as people read them: 950, 8200, 12k, 1.3M. */
export const fmtRequests = (n: number): string => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

const ROWS: [keyof CoverageSummary, string][] = [
  ["fields", "Output fields"],
  ["arguments", "Arguments"],
  ["inputFields", "Input fields"],
  ["inputFieldsBothStates", "Optional inputs, sent and omitted"],
  ["enumValues", "Enum values"],
  ["enumValuesObserved", "Enum values in responses"],
  ["types", "Types"],
];

const pct = (r: Ratio) => `${r.percent}%`;
const change = (head: Ratio, base?: Ratio) => {
  if (!base) return "new";
  const d = Math.round((head.percent - base.percent) * 100) / 100;
  return d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "=";
};
const code = (s: string) => `\`${s}\``;

function details(title: string, items: string[], limit = 50): string {
  if (!items.length) return "";
  const shown = items.slice(0, limit).map((i) => `- ${i}`);
  if (items.length > limit) shown.push(`- … and ${items.length - limit} more`);
  return `<details><summary>${title} (${items.length})</summary>\n\n${shown.join("\n")}\n\n</details>\n`;
}

/**
 * A Markdown summary for a pull request comment or a CI job summary. With a base report it shows the change
 * per metric and lists lost coverage, schema additions without a test, and what became covered.
 */
export function toMarkdown(head: CoverageReport, base?: CoverageReport): string {
  const out: string[] = ["### GraphQL schema coverage", ""];
  const ops = head.operations;
  out.push(`${ops.total} operations (${ops.query} queries, ${ops.mutation} mutations, ${ops.subscription} subscriptions)${ops.invalid ? `, ${ops.invalid} invalid` : ""}${ops.unresolved ? `, ${ops.unresolved} unresolved persisted ids` : ""}.`, "");

  const rows = ROWS.filter(([k]) => head.summary[k]);
  const usage = head.usage?.usedFields;
  if (base) {
    out.push("| Metric | Base | This change | Change |", "| --- | ---: | ---: | ---: |");
    for (const [k, label] of rows) out.push(`| ${label} | ${base.summary[k] ? pct(base.summary[k]) : "–"} | ${pct(head.summary[k])} | ${change(head.summary[k], base.summary[k])} |`);
    if (usage) out.push(`| Production fields tested | ${base.usage ? pct(base.usage.usedFields) : "–"} | ${pct(usage)} | ${change(usage, base.usage?.usedFields)} |`);
  } else {
    out.push("| Metric | Coverage | Covered |", "| --- | ---: | ---: |");
    for (const [k, label] of rows) out.push(`| ${label} | ${pct(head.summary[k])} | ${head.summary[k].covered} of ${head.summary[k].total} |`);
    if (usage) out.push(`| Production fields tested | ${pct(usage)} | ${usage.covered} of ${usage.total} |`);
  }
  out.push("");

  const subgraphs = Object.keys(head.subgraphs ?? {});
  if (subgraphs.length) {
    out.push("| Subgraph | Output fields | Input fields | Enum values |", "| --- | ---: | ---: | ---: |");
    for (const n of subgraphs) {
      const h = head.subgraphs![n];
      const b = base?.subgraphs?.[n];
      const cell = (k: keyof CoverageSummary) => `${pct(h[k])}${base ? ` (${change(h[k], b?.[k])})` : ""}`;
      out.push(`| ${n} | ${cell("fields")} | ${cell("inputFields")} | ${cell("enumValues")} |`);
    }
    out.push("");
  }

  if (base) {
    const d = diffReports(base, head);
    const covered = coveredPaths(head);
    out.push(
      details("Lost coverage", d.lostCoverage.map(code)) +
        details("New in the schema, not tested", d.schemaAdded.filter((p) => !covered.get(p)).map(code)) +
        details("Newly covered", d.newlyCovered.map(code)) +
        details("Removed from the schema", d.schemaRemoved.map(code)),
    );
  } else {
    const u = uncovered(head);
    out.push(
      details("Untested output fields", u.fields.map(code)) +
        details("Untested arguments", u.arguments.map(code)) +
        details("Untested input fields", u.inputFields.map(code)) +
        details("Untested enum values", u.enumValues.map(code)),
    );
  }
  if (head.usage?.untestedUsed.length) out.push(details("Used in production, never tested", head.usage.untestedUsed.map((x) => `${code(x.path)}: ${fmtRequests(x.requests)} requests`), 25));

  const meta = [head.run?.sha && `commit ${head.run.sha.slice(0, 10)}`, `schema ${head.schemaHash}`].filter(Boolean).join(" · ");
  out.push(`<sub>gqlcov · ${meta}</sub>`, "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
