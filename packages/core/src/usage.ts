import type { CoverageReport, Ratio, UsageData, UsageJoin } from "./types.js";

function ratio(covered: number, total: number): Ratio {
  return { covered, total, percent: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100 };
}

/** Accept `{ fields: {...} }` or a bare `{ "Type.field": n }` map, as a file or an already parsed object. */
export function parseUsage(input: string | object): UsageData {
  const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
  if (obj.fields && typeof obj.fields === "object") {
    const { fields, ...rest } = obj;
    return { ...(rest as Omit<UsageData, "fields">), fields: fields as Record<string, number> };
  }
  const fields: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "number") fields[k] = v;
  return { fields };
}

/**
 * Join production field usage with the report: every output field gets `requests`, and `report.usage` lists
 * what is used but untested (the risk), tested but unused, and neither. Usage paths are "Type.field".
 */
export function applyUsage(report: CoverageReport, usage: UsageData): CoverageReport {
  const unknown: string[] = [];
  for (const t of Object.values(report.types)) for (const f of Object.values(t.fields)) delete f.requests;
  for (const [path, n] of Object.entries(usage.fields)) {
    const dot = path.indexOf(".");
    const f = dot > 0 ? report.types[path.slice(0, dot)]?.fields[path.slice(dot + 1)] : undefined;
    if (!f) {
      if (n > 0) unknown.push(path);
      continue;
    }
    f.requests = (f.requests ?? 0) + n;
  }
  report.usage = { ...summariseUsage(report), unknown: unknown.sort() };
  if (usage.source) report.usage.source = usage.source;
  if (usage.from) report.usage.from = usage.from;
  if (usage.to) report.usage.to = usage.to;
  return report;
}

/** Recompute the usage join from the `requests` already on the fields (after a merge, for instance). */
export function summariseUsage(report: CoverageReport): Omit<UsageJoin, "source" | "from" | "to" | "unknown"> {
  const untestedUsed: { path: string; requests: number }[] = [];
  const testedUnused: string[] = [];
  const unusedUntested: string[] = [];
  let used = 0;
  let usedTested = 0;
  for (const [tn, t] of Object.entries(report.types)) {
    for (const [fn, f] of Object.entries(t.fields)) {
      const path = `${tn}.${fn}`;
      const inProd = (f.requests ?? 0) > 0;
      if (inProd) {
        used++;
        if (f.hits > 0) usedTested++;
        else untestedUsed.push({ path, requests: f.requests! });
      } else if (f.hits > 0) testedUnused.push(path);
      else unusedUntested.push(path);
    }
  }
  untestedUsed.sort((a, b) => b.requests - a.requests || a.path.localeCompare(b.path));
  return { usedFields: ratio(usedTested, used), untestedUsed, testedUnused: testedUnused.sort(), unusedUntested: unusedUntested.sort() };
}
