import type { CoverageReport, InvalidOperation } from "./types.js";

const MAX_SOURCES = 10;

/** Add one invalid capture to the report's list, grouping by operation name and error messages. */
export function addInvalid(report: CoverageReport, entry: InvalidOperation): void {
  const list = (report.invalid ??= []);
  const key = (x: InvalidOperation) => JSON.stringify([x.operationName, x.errors]);
  const k = key(entry);
  const found = list.find((x) => key(x) === k);
  if (!found) {
    list.push({ ...entry, sources: entry.sources.slice(0, MAX_SOURCES) });
    return;
  }
  found.count += entry.count;
  for (const s of entry.sources) if (!found.sources.includes(s) && found.sources.length < MAX_SOURCES) found.sources.push(s);
}
