import { summarise, summariseResponses, tagTest } from "./coverage.js";
import { summariseIdentities } from "./identities.js";
import { summariseSubgraphs } from "./subgraphs.js";
import { summariseUsage } from "./usage.js";
import type { CoverageReport } from "./types.js";
import { addValueClasses } from "./values.js";
import { addInvalid } from "./invalid.js";

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
    if (r.operations.responses) out.operations.responses = (out.operations.responses ?? 0) + r.operations.responses;
    for (const [an, a] of Object.entries(r.abstractTypes ?? {})) {
      const oa = out.abstractTypes?.[an];
      if (!oa) continue;
      oa.seen += a.seen;
      for (const [tn, n] of Object.entries(a.possible)) if (oa.possible[tn] !== undefined) oa.possible[tn] += n;
    }
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
        for (const [id, h] of Object.entries(f.identities ?? {})) (of.identities ??= {})[id] = (of.identities[id] ?? 0) + h;
        union(of, f);
        if (f.returned) {
          const ret = (of.returned ??= { value: 0, null: 0, empty: 0 });
          for (const k of ["value", "null", "empty"] as const) ret[k] += f.returned[k];
          if (f.returned.error) ret.error = (ret.error ?? 0) + f.returned.error;
        }
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
        if (of.nulled !== undefined || f.nulled !== undefined) of.nulled = (of.nulled ?? 0) + (f.nulled ?? 0);
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
    for (const x of r.invalid ?? []) addInvalid(out, x);
    for (const [k, v] of Object.entries(r.argumentValues)) if (out.argumentValues[k]) out.argumentValues[k] = addValueClasses(out.argumentValues[k], v);
  }
  out.summary = summarise(out);
  summariseResponses(out);
  const identities = summariseIdentities(out);
  if (identities) out.identities = identities;
  if (out.subgraphs) out.subgraphs = summariseSubgraphs(out);
  if (out.usage) out.usage = { ...out.usage, ...summariseUsage(out) };
  return out;
}
