import { Kind, parse, type DocumentNode, type FieldDefinitionNode, type InputValueDefinitionNode } from "graphql";
import type { CoverageReport } from "./types.js";

/** Where each coverable element sits in the SDL text. Keys: "Type.field", "Type.field(arg)", "Input.field", "Enum.VALUE". */
export type SchemaLineMap = Map<string, number>;

/** Line numbers of every field, argument, input field and enum value in an SDL document (extensions included). */
export function schemaLineMap(sdl: string | DocumentNode): SchemaLineMap {
  const doc = typeof sdl === "string" ? parse(sdl, { noLocation: false }) : sdl;
  const map: SchemaLineMap = new Map();
  const line = (n: { loc?: { startToken: { line: number } } }) => n.loc?.startToken.line ?? 0;
  const fields = (typeName: string, defs: readonly FieldDefinitionNode[] | undefined) => {
    for (const f of defs ?? []) {
      map.set(`${typeName}.${f.name.value}`, line(f));
      for (const a of f.arguments ?? []) map.set(`${typeName}.${f.name.value}(${a.name.value})`, line(a));
    }
  };
  const inputs = (typeName: string, defs: readonly InputValueDefinitionNode[] | undefined) => {
    for (const f of defs ?? []) map.set(`${typeName}.${f.name.value}`, line(f));
  };
  for (const d of doc.definitions) {
    switch (d.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
      case Kind.OBJECT_TYPE_EXTENSION:
      case Kind.INTERFACE_TYPE_DEFINITION:
      case Kind.INTERFACE_TYPE_EXTENSION:
        fields(d.name.value, d.fields);
        break;
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      case Kind.INPUT_OBJECT_TYPE_EXTENSION:
        inputs(d.name.value, d.fields);
        break;
      case Kind.ENUM_TYPE_DEFINITION:
      case Kind.ENUM_TYPE_EXTENSION:
        for (const v of d.values ?? []) map.set(`${d.name.value}.${v.name.value}`, line(v));
        break;
    }
  }
  return map;
}

interface Element { path: string; line: number; hits: number; kind: "field" | "input" | "enum"; root: boolean }
interface Branch { path: string; line: number; arms: { name: string; hits: number }[] }

const ROOTS = new Set(["Query", "Mutation", "Subscription"]);

/** Flatten the report onto SDL lines: fields, input fields and enum values become lines; arguments and optional-input states become branches. */
function elements(report: CoverageReport, lines: SchemaLineMap): { els: Element[]; branches: Branch[] } {
  const els: Element[] = [];
  const branches: Branch[] = [];
  for (const [tn, t] of Object.entries(report.types)) {
    for (const [fn, f] of Object.entries(t.fields)) {
      const path = `${tn}.${fn}`;
      const line = lines.get(path);
      if (!line) continue;
      els.push({ path, line, hits: f.hits, kind: "field", root: ROOTS.has(tn) });
      const args = Object.entries(f.args);
      if (args.length) branches.push({ path, line, arms: args.map(([an, a]) => ({ name: an, hits: a.hits })) });
    }
  }
  for (const [tn, t] of Object.entries(report.inputTypes)) {
    for (const [fn, f] of Object.entries(t.fields)) {
      const path = `${tn}.${fn}`;
      const line = lines.get(path);
      if (!line) continue;
      els.push({ path, line, hits: f.sent, kind: "input", root: false });
      if (!f.required) branches.push({ path, line, arms: [{ name: "sent", hits: f.sent }, { name: "omitted", hits: f.omitted }] });
    }
  }
  for (const [en, e] of Object.entries(report.enums)) {
    for (const [vn, v] of Object.entries(e.values)) {
      const path = `${en}.${vn}`;
      const line = lines.get(path);
      if (!line) continue;
      els.push({ path, line, hits: v.hits, kind: "enum", root: false });
    }
  }
  els.sort((a, b) => a.line - b.line);
  branches.sort((a, b) => a.line - b.line);
  return { els, branches };
}

/**
 * LCOV for Codecov, Coveralls, SonarQube (via lcov import) and `genhtml`.
 * Lines = output fields, input fields, enum values. Functions = root operation fields. Branches = arguments and optional-input sent/omitted.
 */
export function toLcov(report: CoverageReport, sdl: string | DocumentNode, schemaPath: string): string {
  const { els, branches } = elements(report, schemaLineMap(sdl));
  const out: string[] = ["TN:gqlcov", `SF:${schemaPath}`];
  const roots = els.filter((e) => e.root);
  for (const r of roots) out.push(`FN:${r.line},${r.path}`);
  for (const r of roots) out.push(`FNDA:${r.hits},${r.path}`);
  out.push(`FNF:${roots.length}`, `FNH:${roots.filter((r) => r.hits > 0).length}`);
  let bf = 0, bh = 0;
  branches.forEach((b, bi) => {
    b.arms.forEach((arm, ai) => {
      out.push(`BRDA:${b.line},${bi},${ai},${arm.hits}`);
      bf++;
      if (arm.hits > 0) bh++;
    });
  });
  out.push(`BRF:${bf}`, `BRH:${bh}`);
  // Several elements can share a line (args on the field line); a line counts as hit when any element on it was hit.
  const perLine = new Map<number, number>();
  for (const e of els) perLine.set(e.line, Math.max(perLine.get(e.line) ?? 0, e.hits));
  for (const [line, hits] of [...perLine.entries()].sort((a, b) => a[0] - b[0])) out.push(`DA:${line},${hits}`);
  out.push(`LF:${perLine.size}`, `LH:${[...perLine.values()].filter((h) => h > 0).length}`, "end_of_record", "");
  return out.join("\n");
}

/** Istanbul `coverage-final.json` shape, so `nyc report`, `istanbul-merge`, Codecov and Jest tooling accept it as one more file. */
export function toIstanbul(report: CoverageReport, sdl: string | DocumentNode, schemaPath: string): Record<string, unknown> {
  const { els, branches } = elements(report, schemaLineMap(sdl));
  const loc = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 0 } });
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  const fnMap: Record<string, unknown> = {};
  const f: Record<string, number> = {};
  const branchMap: Record<string, unknown> = {};
  const b: Record<string, number[]> = {};
  els.forEach((e, i) => {
    statementMap[i] = loc(e.line);
    s[i] = e.hits;
  });
  let fi = 0;
  for (const e of els) {
    if (!e.root) continue;
    fnMap[fi] = { name: e.path, decl: loc(e.line), loc: loc(e.line), line: e.line };
    f[fi] = e.hits;
    fi++;
  }
  branches.forEach((br, i) => {
    branchMap[i] = { type: "gqlcov", line: br.line, loc: loc(br.line), locations: br.arms.map(() => loc(br.line)) };
    b[i] = br.arms.map((a) => a.hits);
  });
  return { [schemaPath]: { path: schemaPath, statementMap, fnMap, branchMap, s, f, b } };
}
