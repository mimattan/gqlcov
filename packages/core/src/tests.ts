import type { CoverageReport, TestCoverage } from "./types.js";

/**
 * Coverage per test, from the `tests` lists the report carries when captures had a `source` label.
 * Tests that ran operations but covered nothing still appear, with empty lists.
 */
export function testCoverage(report: CoverageReport): TestCoverage[] {
  const byTest = new Map<string, TestCoverage>();
  const get = (name: string) => {
    let t = byTest.get(name);
    if (!t) byTest.set(name, (t = { name, operations: 0, fields: [], arguments: [], inputFields: [], enumValues: [], unique: [] }));
    return t;
  };
  for (const [name, n] of Object.entries(report.tests ?? {})) get(name).operations = n;
  const add = (tests: string[] | undefined, path: string, list: "fields" | "arguments" | "inputFields" | "enumValues") => {
    if (!tests) return;
    for (const name of tests) get(name)[list].push(path);
    if (tests.length === 1) get(tests[0]).unique.push(path);
  };
  for (const [tn, t] of Object.entries(report.types))
    for (const [fn, f] of Object.entries(t.fields)) {
      add(f.tests, `${tn}.${fn}`, "fields");
      for (const [an, a] of Object.entries(f.args)) add(a.tests, `${tn}.${fn}(${an})`, "arguments");
    }
  for (const [tn, t] of Object.entries(report.inputTypes)) for (const [fn, f] of Object.entries(t.fields)) add(f.tests, `${tn}.${fn}`, "inputFields");
  for (const [en, e] of Object.entries(report.enums)) for (const [vn, v] of Object.entries(e.values)) add(v.tests, `${en}.${vn}`, "enumValues");
  const out = [...byTest.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of out) for (const list of [t.fields, t.arguments, t.inputFields, t.enumValues, t.unique]) list.sort();
  return out;
}
