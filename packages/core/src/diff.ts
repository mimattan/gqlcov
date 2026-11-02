import { UNGATED_SUMMARY_KEYS, type CoverageDiff, type CoverageReport, type CoverageSummary, type GateOptions, type GateResult } from "./types.js";

/** Flatten every coverable element to "path -> covered?" */
export function coveredPaths(r: CoverageReport): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const [tn, t] of Object.entries(r.types)) {
    m.set(tn, t.hits > 0);
    for (const [fn, f] of Object.entries(t.fields)) {
      m.set(`${tn}.${fn}`, f.hits > 0);
      for (const [an, a] of Object.entries(f.args)) m.set(`${tn}.${fn}(${an})`, a.hits > 0);
    }
  }
  for (const [tn, t] of Object.entries(r.inputTypes)) for (const [fn, f] of Object.entries(t.fields)) m.set(`${tn}.${fn}`, f.sent > 0);
  for (const [en, e] of Object.entries(r.enums)) for (const [vn, v] of Object.entries(e.values)) m.set(`${en}.${vn}`, v.hits > 0);
  return m;
}

export function diffReports(base: CoverageReport, head: CoverageReport): CoverageDiff {
  const b = coveredPaths(base);
  const h = coveredPaths(head);
  const newlyCovered: string[] = [];
  const lostCoverage: string[] = [];
  const schemaAdded: string[] = [];
  const schemaRemoved: string[] = [];
  for (const [p, covered] of h) {
    if (!b.has(p)) schemaAdded.push(p);
    else if (covered && !b.get(p)) newlyCovered.push(p);
    else if (!covered && b.get(p)) lostCoverage.push(p);
  }
  for (const p of b.keys()) if (!h.has(p)) schemaRemoved.push(p);
  // Keys missing from either side (a report from an older version) have no delta.
  const keys = (Object.keys(head.summary) as (keyof CoverageSummary)[]).filter((k) => base.summary[k]);
  const deltaOf = (b: CoverageSummary, h: CoverageSummary) =>
    Object.fromEntries(keys.filter((k) => b[k] && h[k]).map((k) => [k, Math.round((h[k].percent - b[k].percent) * 100) / 100])) as CoverageDiff["delta"];
  const delta = deltaOf(base.summary, head.summary);
  const shared = Object.keys(head.subgraphs ?? {}).filter((n) => base.subgraphs?.[n]);
  const subgraphs = shared.length ? Object.fromEntries(shared.map((n) => [n, deltaOf(base.subgraphs![n], head.subgraphs![n])])) : undefined;
  return {
    base: { summary: base.summary, generatedAt: base.generatedAt, ...(base.subgraphs ? { subgraphs: base.subgraphs } : {}) },
    head: { summary: head.summary, generatedAt: head.generatedAt, ...(head.subgraphs ? { subgraphs: head.subgraphs } : {}) },
    delta,
    newlyCovered: newlyCovered.sort(),
    lostCoverage: lostCoverage.sort(),
    schemaAdded: schemaAdded.sort(),
    schemaRemoved: schemaRemoved.sort(),
    ...(subgraphs ? { subgraphs } : {}),
  };
}

export function gate(report: CoverageReport, options: GateOptions): GateResult {
  const failures: string[] = [];
  const scopes: { label: string; summary: CoverageSummary; baseSummary?: CoverageSummary; delta?: Record<string, number> }[] = [];
  const d = options.base ? diffReports(options.base, report) : undefined;
  if (options.subgraphs?.length) {
    const wanted = options.subgraphs.includes("*") ? Object.keys(report.subgraphs ?? {}) : options.subgraphs;
    if (wanted.length === 0) failures.push(`every subgraph was asked for, but the report has no subgraph attribution`);
    for (const name of wanted) {
      const summary = report.subgraphs?.[name];
      if (!summary) {
        failures.push(`subgraph "${name}" is not in the report${report.subgraphs ? ` (known: ${Object.keys(report.subgraphs).join(", ")})` : " (no subgraph attribution)"}`);
        continue;
      }
      scopes.push({ label: `[${name}] `, summary, baseSummary: options.base?.subgraphs?.[name], delta: d?.subgraphs?.[name] });
    }
  } else {
    scopes.push({ label: "", summary: report.summary, baseSummary: options.base?.summary, delta: d?.delta });
  }
  for (const { label, summary: s, baseSummary, delta } of scopes) {
    if (options.minFields !== undefined && s.fields.percent < options.minFields)
      failures.push(`${label}field coverage ${s.fields.percent}% is below the minimum ${options.minFields}%`);
    if (options.minInputFields !== undefined && s.inputFields.percent < options.minInputFields)
      failures.push(`${label}input-field coverage ${s.inputFields.percent}% is below the minimum ${options.minInputFields}%`);
    if (options.minEnumValues !== undefined && s.enumValues.percent < options.minEnumValues)
      failures.push(`${label}enum-value coverage ${s.enumValues.percent}% is below the minimum ${options.minEnumValues}%`);
    if (delta && baseSummary) {
      const tol = options.tolerance ?? 0;
      for (const [k, v] of Object.entries(delta)) {
        if (UNGATED_SUMMARY_KEYS.includes(k as keyof CoverageSummary)) continue;
        if (v < -tol) failures.push(`${label}${k} coverage dropped by ${Math.abs(v)} points (${baseSummary[k as keyof CoverageSummary].percent}% to ${s[k as keyof CoverageSummary].percent}%)`);
      }
    }
  }
  if (options.minUsedFields !== undefined) {
    const u = report.usage;
    if (!u) failures.push(`--min-used-fields needs production usage in the report (gqlcov report --usage)`);
    else if (u.usedFields.percent < options.minUsedFields)
      failures.push(`${u.usedFields.percent}% of fields with production traffic are tested, below the minimum ${options.minUsedFields}% (${u.untestedUsed.length} untested: ${u.untestedUsed.slice(0, 10).map((x) => x.path).join(", ")}${u.untestedUsed.length > 10 ? ", ..." : ""})`);
  }
  if (d && d.lostCoverage.length > 0) {
    const inScope = options.subgraphs?.length ? d.lostCoverage.filter((p) => pathInSubgraphs(report, p, options.subgraphs!)) : d.lostCoverage;
    if (inScope.length > 0) failures.push(`lost coverage on: ${inScope.slice(0, 20).join(", ")}${inScope.length > 20 ? ` and ${inScope.length - 20} more` : ""}`);
  }
  return { passed: failures.length === 0, failures };
}

/** Whether a "Type", "Type.field", "Type.field(arg)", "Input.field" or "Enum.VALUE" path belongs to one of the subgraphs. */
function pathInSubgraphs(report: CoverageReport, path: string, subgraphs: string[]): boolean {
  if (subgraphs.includes("*")) return true;
  // Paths come from coveredPaths(report): an object type, its fields and arguments, input fields, enum values.
  const [, tn, fn] = /^([^.(]+)(?:\.([^.(]+))?/.exec(path)!;
  const el = fn === undefined ? report.types[tn] : (report.types[tn]?.fields[fn] ?? report.inputTypes[tn]?.fields[fn] ?? report.enums[tn].values[fn]);
  return el.graphs?.some((g) => subgraphs.includes(g)) ?? false;
}

/** Uncovered elements, grouped, for the "what to test next" list. */
export function uncovered(report: CoverageReport): { fields: string[]; arguments: string[]; inputFields: string[]; enumValues: string[] } {
  const out = { fields: [] as string[], arguments: [] as string[], inputFields: [] as string[], enumValues: [] as string[] };
  for (const [tn, t] of Object.entries(report.types))
    for (const [fn, f] of Object.entries(t.fields)) {
      if (f.hits === 0) out.fields.push(`${tn}.${fn}`);
      for (const [an, a] of Object.entries(f.args)) if (a.hits === 0) out.arguments.push(`${tn}.${fn}(${an})`);
    }
  for (const [tn, t] of Object.entries(report.inputTypes)) for (const [fn, f] of Object.entries(t.fields)) if (f.sent === 0) out.inputFields.push(`${tn}.${fn}`);
  for (const [en, e] of Object.entries(report.enums)) {
    if (e.input === false) continue; // output-only: nothing a test can send
    for (const [vn, v] of Object.entries(e.values)) if (v.hits === 0) out.enumValues.push(`${en}.${vn}`);
  }
  for (const k of Object.keys(out) as (keyof typeof out)[]) out[k].sort();
  return out;
}
