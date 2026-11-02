import { summarise, tagTest } from "./coverage.js";
import { summariseSubgraphs } from "./subgraphs.js";
import { summariseUsage } from "./usage.js";
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
    if (r.operations.unresolved) out.operations.unresolved = (out.operations.unresolved ?? 0) + r.operations.unresolved;
    for (const [k, v] of Object.entries(r.operations.named)) out.operations.named[k] = (out.operations.named[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.tests ?? {})) (out.tests ??= {})[k] = (out.tests[k] ?? 0) + v;
    const union = (into: { tests?: string[] }, from: { tests?: string[] }) => from.tests?.forEach((t) => tagTest(into, t));
    for (const [tn, t] of Object.entries(r.types)) {
      const ot = out.types[tn];
      if (!ot) continue;
      ot.hits += t.hits;
      for (const [fn, f] of Object.entries(t.fields)) {
        const of = ot.fields[fn];
        if (!of) continue;
        of.hits += f.hits;
        union(of, f);
        for (const [an, a] of Object.entries(f.args)) {
          const oa = of.args[an];
          if (!oa) continue;
          oa.hits += a.hits;
          union(oa, a);
        }
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
        union(of, f);
        of.omitted += f.omitted;
        of.values = addValueClasses(of.values, f.values);
      }
    }
    for (const [en, e] of Object.entries(r.enums)) {
      const oe = out.enums[en];
      if (!oe) continue;
      for (const [vn, v] of Object.entries(e.values)) {
        const ov = oe.values[vn];
        if (!ov) continue;
        ov.hits += v.hits;
        union(ov, v);
        ov.observed = (ov.observed ?? 0) + (v.observed ?? 0);
      }
    }
    for (const [k, v] of Object.entries(r.argumentValues)) if (out.argumentValues[k]) out.argumentValues[k] = addValueClasses(out.argumentValues[k], v);
  }
  out.summary = summarise(out);
  if (out.subgraphs) out.subgraphs = summariseSubgraphs(out);
  if (out.usage) out.usage = { ...out.usage, ...summariseUsage(out) };
  return out;
}
