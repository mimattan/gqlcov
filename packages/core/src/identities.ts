import { globToRegExp } from "./exclude.js";
import type { CoverageReport, Ratio } from "./types.js";

// Only called with total >= 1: an identity is only known from a field that exists.
const ratio = (covered: number, total: number): Ratio => ({ covered, total, percent: Math.round((covered / total) * 10000) / 100 });

/** Output-field coverage per identity: fields each identity requested, out of every included field. */
export function summariseIdentities(report: Pick<CoverageReport, "types">): Record<string, Ratio> | undefined {
  const counts = new Map<string, number>();
  let total = 0;
  for (const t of Object.values(report.types))
    for (const f of Object.values(t.fields)) {
      total++;
      for (const [id, hits] of Object.entries(f.identities ?? {})) if (hits > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  if (!counts.size) return undefined;
  return Object.fromEntries([...counts.keys()].sort().map((id) => [id, ratio(counts.get(id)!, total)]));
}

/** The default scope of `identityGaps`: mutations, where a missing "not allowed" test hurts most. */
export const DEFAULT_IDENTITY_SCOPE = ["Mutation.*"];

/**
 * Requested fields in scope ("Type.field" patterns, `*` within a segment) that fewer than `min` distinct
 * identities requested, with the identities that did. Fields no test requested are left to the coverage numbers.
 */
export function identityGaps(report: CoverageReport, min: number, scope: string[] = DEFAULT_IDENTITY_SCOPE): { path: string; identities: string[] }[] {
  const patterns = scope.map(globToRegExp);
  const out: { path: string; identities: string[] }[] = [];
  for (const [tn, t] of Object.entries(report.types))
    for (const [fn, f] of Object.entries(t.fields)) {
      const path = `${tn}.${fn}`;
      if (f.hits === 0 || !patterns.some((p) => p.test(path))) continue;
      const ids = Object.entries(f.identities ?? {}).filter(([, h]) => h > 0).map(([id]) => id).sort();
      if (ids.length < min) out.push({ path, identities: ids });
    }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
