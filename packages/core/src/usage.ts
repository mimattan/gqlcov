import type { CoverageReport, Ratio, UsageData, UsageJoin, UsageKind } from "./types.js";

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

/** An element the usage join can count, with what "tested" means for it. */
interface Joinable {
  path: string;
  kind: UsageKind;
  el: { requests?: number };
  tested: boolean;
}

/** Output fields, input fields, and values of enums a client can send. Output-only enum values are not joined. */
function joinables(report: CoverageReport): Joinable[] {
  const out: Joinable[] = [];
  for (const [tn, t] of Object.entries(report.types)) for (const [fn, f] of Object.entries(t.fields)) out.push({ path: `${tn}.${fn}`, kind: "field", el: f, tested: f.hits > 0 });
  for (const [tn, t] of Object.entries(report.inputTypes)) for (const [fn, f] of Object.entries(t.fields)) out.push({ path: `${tn}.${fn}`, kind: "inputField", el: f, tested: f.sent > 0 });
  for (const [en, e] of Object.entries(report.enums)) {
    if (e.input === false) continue;
    for (const [vn, v] of Object.entries(e.values)) out.push({ path: `${en}.${vn}`, kind: "enumValue", el: v, tested: v.hits > 0 });
  }
  return out;
}

/**
 * Join production usage with the report: every element the usage names gets `requests`, and `report.usage`
 * lists what is used but untested (the risk), tested but unused, and neither. Usage paths are schema
 * coordinates: "Type.field", "Input.field" or "Enum.VALUE".
 */
export function applyUsage(report: CoverageReport, usage: UsageData): CoverageReport {
  const all = joinables(report);
  const byPath = new Map(all.map((j) => [j.path, j]));
  const unknown: string[] = [];
  for (const j of all) delete j.el.requests;
  for (const [path, n] of Object.entries(usage.fields)) {
    const j = byPath.get(path);
    if (j) j.el.requests = (j.el.requests ?? 0) + n;
    else if (n > 0 && !isOutputEnumValue(report, path)) unknown.push(path);
  }
  report.usage = { ...summariseUsage(report), unknown: unknown.sort() };
  if (usage.source) report.usage.source = usage.source;
  if (usage.from) report.usage.from = usage.from;
  if (usage.to) report.usage.to = usage.to;
  return report;
}

/** Values of output-only enums are in the schema but not joined: nothing a test sends can cover them. */
function isOutputEnumValue(report: CoverageReport, path: string): boolean {
  const [en, vn] = path.split(".");
  return report.enums[en]?.values[vn] !== undefined;
}

/** Recompute the usage join from the `requests` already on the elements (after a merge, for instance). */
export function summariseUsage(report: CoverageReport): Omit<UsageJoin, "source" | "from" | "to" | "unknown"> {
  const all = joinables(report);
  // Inputs join only when the usage data said something about them; otherwise every input would look unused.
  const inputsCovered = all.some((j) => j.kind !== "field" && j.el.requests !== undefined);
  const untestedUsed: UsageJoin["untestedUsed"] = [];
  const testedUnused: string[] = [];
  const unusedUntested: string[] = [];
  const count = { field: [0, 0], input: [0, 0] };
  for (const j of all) {
    if (j.kind !== "field" && !inputsCovered) continue;
    const bucket = j.kind === "field" ? count.field : count.input;
    const requests = j.el.requests ?? 0;
    if (requests > 0) {
      bucket[1]++;
      if (j.tested) bucket[0]++;
      else untestedUsed.push({ path: j.path, requests, kind: j.kind });
    } else if (j.tested) testedUnused.push(j.path);
    else unusedUntested.push(j.path);
  }
  untestedUsed.sort((a, b) => b.requests - a.requests || a.path.localeCompare(b.path));
  return {
    usedFields: ratio(count.field[0], count.field[1]),
    ...(inputsCovered ? { usedInputs: ratio(count.input[0], count.input[1]) } : {}),
    untestedUsed,
    testedUnused: testedUnused.sort(),
    unusedUntested: unusedUntested.sort(),
  };
}
