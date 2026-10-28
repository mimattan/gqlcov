import { summarise } from "./coverage.js";
import type { CoverageReport } from "./types.js";
import { addValueClasses } from "./values.js";

/** Merge reports from parallel shards. All reports must share a schema hash. */
export function mergeReports(reports: CoverageReport[]): CoverageReport {
  if (reports.length === 0) throw new Error("mergeReports: no reports given");
  const hashes = new Set(reports.map((r) => r.schemaHash));
  if (hashes.size > 1) throw new Error(`mergeReports: schema hashes differ (${[...hashes].join(", ")})`);
  const out: CoverageReport = structuredClone(reports[0]);
  out.generatedAt = new Date().toISOString();
  for (const r of reports.slice(1)) {
    out.operations.total += r.operations.total;
    out.operations.query += r.operations.query;
    out.operations.mutation += r.operations.mutation;
    out.operations.subscription += r.operations.subscription;
    out.operations.invalid += r.operations.invalid;
    for (const [k, v] of Object.entries(r.operations.named)) out.operations.named[k] = (out.operations.named[k] ?? 0) + v;
    for (const [tn, t] of Object.entries(r.types)) {
      const ot = out.types[tn];
      if (!ot) continue;
      ot.hits += t.hits;
      for (const [fn, f] of Object.entries(t.fields)) {
        const of = ot.fields[fn];
        if (!of) continue;
        of.hits += f.hits;
        for (const [an, a] of Object.entries(f.args)) if (of.args[an]) of.args[an].hits += a.hits;
      }
    }
    for (const [tn, t] of Object.entries(r.inputTypes)) {
      const ot = out.inputTypes[tn];
      if (!ot) continue;
      ot.hits += t.hits;
      for (const [fn, f] of Object.entries(t.fields)) {
        const of = ot.fields[fn];
        if (!of) continue;
        of.sent += f.sent;
        of.omitted += f.omitted;
        of.values = addValueClasses(of.values, f.values);
      }
    }
    for (const [en, e] of Object.entries(r.enums)) {
      const oe = out.enums[en];
      if (!oe) continue;
      for (const [vn, v] of Object.entries(e.values)) if (oe.values[vn]) oe.values[vn].hits += v.hits;
    }
    for (const [k, v] of Object.entries(r.argumentValues)) if (out.argumentValues[k]) out.argumentValues[k] = addValueClasses(out.argumentValues[k], v);
  }
  out.summary = summarise(out);
  return out;
}
