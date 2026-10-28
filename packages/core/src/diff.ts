import type { CoverageDiff, CoverageReport, CoverageSummary, GateOptions, GateResult } from "./types.js";

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
  const keys = Object.keys(head.summary) as (keyof CoverageSummary)[];
  const delta = Object.fromEntries(keys.map((k) => [k, Math.round((head.summary[k].percent - base.summary[k].percent) * 100) / 100])) as CoverageDiff["delta"];
  return {
    base: { summary: base.summary, generatedAt: base.generatedAt },
    head: { summary: head.summary, generatedAt: head.generatedAt },
    delta,
    newlyCovered: newlyCovered.sort(),
    lostCoverage: lostCoverage.sort(),
    schemaAdded: schemaAdded.sort(),
    schemaRemoved: schemaRemoved.sort(),
  };
}

export function gate(report: CoverageReport, options: GateOptions): GateResult {
  const failures: string[] = [];
  const s = report.summary;
  if (options.minFields !== undefined && s.fields.percent < options.minFields)
    failures.push(`field coverage ${s.fields.percent}% is below the minimum ${options.minFields}%`);
  if (options.minInputFields !== undefined && s.inputFields.percent < options.minInputFields)
    failures.push(`input-field coverage ${s.inputFields.percent}% is below the minimum ${options.minInputFields}%`);
  if (options.minEnumValues !== undefined && s.enumValues.percent < options.minEnumValues)
    failures.push(`enum-value coverage ${s.enumValues.percent}% is below the minimum ${options.minEnumValues}%`);
  if (options.base) {
    const tol = options.tolerance ?? 0;
    const d = diffReports(options.base, report);
    for (const [k, v] of Object.entries(d.delta)) {
      if (v < -tol) failures.push(`${k} coverage dropped by ${Math.abs(v)} points (${options.base.summary[k as keyof CoverageSummary].percent}% to ${report.summary[k as keyof CoverageSummary].percent}%)`);
    }
    if (d.lostCoverage.length > 0) failures.push(`lost coverage on: ${d.lostCoverage.slice(0, 20).join(", ")}${d.lostCoverage.length > 20 ? ` and ${d.lostCoverage.length - 20} more` : ""}`);
  }
  return { passed: failures.length === 0, failures };
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
  for (const [en, e] of Object.entries(report.enums)) for (const [vn, v] of Object.entries(e.values)) if (v.hits === 0) out.enumValues.push(`${en}.${vn}`);
  for (const k of Object.keys(out) as (keyof typeof out)[]) out[k].sort();
  return out;
}
