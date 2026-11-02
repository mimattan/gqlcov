import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { computeCoverage, diffReports, gate, mergeReports, parseUsage, readCaptures, uncovered, toIstanbul, toLcov, DEFAULT_CAPTURE_DIR, type CoverageReport } from "@gqlcov/core";
import { lexicographicSortSchema, printSchema } from "graphql";
import { renderHtml } from "./html.js";
import { loadSchemaFrom } from "./schema-source.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const readReport = (p: string): CoverageReport => JSON.parse(readFileSync(p, "utf8")) as CoverageReport;
const writeOut = (p: string, content: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

function printSummary(r: CoverageReport): void {
  const s = r.summary;
  const line = (label: string, x: { percent: number; covered: number; total: number }) => `  ${label.padEnd(38)} ${String(x.percent).padStart(6)}%  (${x.covered}/${x.total})`;
  console.log(`gqlcov: ${r.operations.total} operations (${r.operations.query} queries, ${r.operations.mutation} mutations, ${r.operations.subscription} subscriptions${r.operations.invalid ? `, ${r.operations.invalid} invalid` : ""}), schema ${r.schemaHash}`);
  console.log(line("Types", s.types));
  console.log(line("Output fields", s.fields));
  console.log(line("Arguments", s.arguments));
  console.log(line("Input-type fields sent", s.inputFields));
  console.log(line("Optional inputs sent and omitted", s.inputFieldsBothStates));
  console.log(line("Enum values sent", s.enumValues));
  // Older reports have no observed number.
  if (s.enumValuesObserved) console.log(line("Enum values in responses (not gated)", s.enumValuesObserved));
  if (r.usage) console.log(line("Production fields tested", r.usage.usedFields));
  printSubgraphs(r);
}

const fmtRequests = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

function printUsage(r: CoverageReport): void {
  const u = r.usage;
  if (!u) return;
  const where = [u.source, u.from && u.to ? `${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}` : undefined].filter(Boolean).join(", ");
  console.log(`\n  production usage${where ? ` (${where})` : ""}: ${u.usedFields.total} fields with traffic, ${u.usedFields.covered} tested, ${u.testedUnused.length} tested without traffic, ${u.unusedUntested.length} neither`);
  if (u.untestedUsed.length) {
    console.log(`  used in production, never tested (${u.untestedUsed.length}):`);
    for (const x of u.untestedUsed.slice(0, 25)) console.log(`    ${x.path.padEnd(44)} ${fmtRequests(x.requests).padStart(8)} requests`);
    if (u.untestedUsed.length > 25) console.log(`    ... and ${u.untestedUsed.length - 25} more`);
  }
  if (u.unknown.length) console.log(`  in usage but not in the schema (${u.unknown.length}): ${u.unknown.slice(0, 10).join(", ")}${u.unknown.length > 10 ? ", ..." : ""}`);
}

function printSubgraphs(r: CoverageReport): void {
  const names = Object.keys(r.subgraphs ?? {});
  if (!names.length) return;
  const w = Math.max(8, ...names.map((n) => n.length));
  const cell = (x: { percent: number; covered: number; total: number }) => `${String(x.percent).padStart(6)}% (${x.covered}/${x.total})`.padEnd(20);
  console.log(`\n  ${"Subgraph".padEnd(w)}  ${"Fields".padEnd(20)}  ${"Arguments".padEnd(20)}  ${"Input fields".padEnd(20)}  Enum values`);
  for (const n of names) {
    const g = r.subgraphs![n];
    console.log(`  ${n.padEnd(w)}  ${cell(g.fields)}  ${cell(g.arguments)}  ${cell(g.inputFields)}  ${cell(g.enumValues).trimEnd()}`);
  }
}

/** `name=path` pairs into a map of subgraph SDL text. */
function readSubgraphSdls(list: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf("=");
    if (i <= 0) throw new Error(`--subgraph expects name=path, got "${item}"`);
    out[item.slice(0, i).trim()] = readFileSync(item.slice(i + 1).trim(), "utf8");
  }
  return out;
}

function parseHeaders(list: string[] = []): Record<string, string> {
  return Object.fromEntries(list.map((h) => { const i = h.indexOf(":"); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }));
}

export function buildCli(): Command {
  const program = new Command("gqlcov").description("GraphQL schema coverage from captured E2E operations").version(version);

  program
    .command("report")
    .description("Compute a coverage report from captured operations")
    .requiredOption("-s, --schema <pointer>", "SDL file, introspection JSON file, or http(s) endpoint")
    .option("-c, --captures <dir...>", "capture folder(s)", [DEFAULT_CAPTURE_DIR])
    .option("-o, --out <file>", "JSON report path", ".gqlcov/report.json")
    .option("--html <file>", "also write an HTML report")
    .option("--lcov <file>", "also write LCOV (Codecov, Coveralls, SonarQube, genhtml); lines map to the schema file")
    .option("--istanbul <file>", "also write Istanbul coverage-final.json (nyc, istanbul-merge, Jest tooling)")
    .option("--schema-out <file>", "where to write the SDL that lcov/istanbul refer to when --schema is an endpoint or introspection JSON", ".gqlcov/schema.graphql")
    .option("-H, --header <header...>", "header for endpoint introspection, e.g. 'Authorization: Bearer x'")
    .option("--exclude <pattern...>", "exclude patterns: Type, Type.field, Type.field(arg), Input.field; * wildcard")
    .option("--subgraph <name=file...>", "attribute elements to subgraphs from one SDL per subgraph (a composed supergraph needs no option: its @join__ directives are read)")
    .option("--usage <file>", "production field usage JSON (from gqlcov usage apollo|cosmo) to list used-but-untested fields")
    .option("--include-deprecated", "count deprecated elements in totals")
    .option("--sha <sha>", "commit SHA for the run", process.env.GITHUB_SHA)
    .option("--branch <name>", "branch for the run", process.env.GITHUB_REF_NAME)
    .option("--untested", "print the uncovered list")
    .option("-q, --quiet", "no console summary")
    .action(async (o) => {
      const schema = await loadSchemaFrom(o.schema, parseHeaders(o.header));
      const ops = readCaptures(o.captures);
      const report = computeCoverage(schema, ops, {
        exclude: o.exclude,
        excludeDeprecated: !o.includeDeprecated,
        run: { sha: o.sha, branch: o.branch, finishedAt: new Date().toISOString() },
        subgraphSdls: readSubgraphSdls(o.subgraph),
        usage: o.usage ? parseUsage(readFileSync(o.usage, "utf8")) : undefined,
      });
      writeOut(o.out, JSON.stringify(report, null, 2));
      if (o.html) writeOut(o.html, renderHtml(report, schema));
      if (o.lcov || o.istanbul) {
        // Line numbers must refer to a file the coverage service can show: the SDL file given, or one we write.
        let sdlPath: string = o.schema;
        let sdl: string;
        if (/^https?:\/\//.test(o.schema) || o.schema.endsWith(".json")) {
          sdl = printSchema(lexicographicSortSchema(schema));
          sdlPath = o.schemaOut;
          writeOut(sdlPath, sdl);
        } else {
          sdl = readFileSync(o.schema, "utf8");
        }
        if (o.lcov) writeOut(o.lcov, toLcov(report, sdl, sdlPath));
        if (o.istanbul) writeOut(o.istanbul, JSON.stringify(toIstanbul(report, sdl, sdlPath)));
      }
      if (!o.quiet) {
        printSummary(report);
        printUsage(report);
        if (ops.length === 0) console.log(`  (no captures found in ${o.captures.join(", ")})`);
        console.log(`  report: ${o.out}${o.html ? `, html: ${o.html}` : ""}${o.lcov ? `, lcov: ${o.lcov}` : ""}${o.istanbul ? `, istanbul: ${o.istanbul}` : ""}`);
        if (o.untested) {
          const u = uncovered(report);
          for (const [k, v] of Object.entries(u)) if (v.length) console.log(`\n  ${k} (${v.length}):\n    ${v.join("\n    ")}`);
        }
      }
    });

  program
    .command("merge")
    .description("Merge reports from parallel shards")
    .argument("<reports...>", "report JSON files")
    .requiredOption("-o, --out <file>", "merged report path")
    .action((reports: string[], o) => {
      const merged = mergeReports(reports.map(readReport));
      writeOut(o.out, JSON.stringify(merged, null, 2));
      printSummary(merged);
    });

  program
    .command("diff")
    .description("Compare two reports")
    .argument("<base>", "base report JSON")
    .argument("<head>", "head report JSON")
    .option("--json", "print the diff as JSON")
    .action((base: string, head: string, o) => {
      const d = diffReports(readReport(base), readReport(head));
      if (o.json) return console.log(JSON.stringify(d, null, 2));
      for (const [k, v] of Object.entries(d.delta)) console.log(`  ${k.padEnd(24)} ${d.base.summary[k as keyof typeof d.base.summary].percent}% -> ${d.head.summary[k as keyof typeof d.head.summary].percent}% (${v >= 0 ? "+" : ""}${v})`);
      const show = (t: string, l: string[]) => l.length && console.log(`\n  ${t} (${l.length}):\n    ${l.join("\n    ")}`);
      for (const [name, delta] of Object.entries(d.subgraphs ?? {})) {
        console.log(`\n  subgraph ${name}`);
        for (const [k, v] of Object.entries(delta)) console.log(`    ${k.padEnd(22)} ${d.base.subgraphs?.[name]?.[k as keyof typeof delta]?.percent}% -> ${d.head.subgraphs?.[name]?.[k as keyof typeof delta]?.percent}% (${v >= 0 ? "+" : ""}${v})`);
      }
      show("newly covered", d.newlyCovered);
      show("lost coverage", d.lostCoverage);
      show("added to schema", d.schemaAdded);
      show("removed from schema", d.schemaRemoved);
    });

  program
    .command("gate")
    .description("Exit non-zero when coverage is below a minimum or dropped versus a base report")
    .argument("<report>", "report JSON")
    .option("--min-fields <pct>", "minimum output-field coverage", parseFloat)
    .option("--min-input-fields <pct>", "minimum input-field coverage", parseFloat)
    .option("--min-enum-values <pct>", "minimum coverage of enum values sent as input", parseFloat)
    .option("--base <report>", "fail on any decrease versus this report")
    .option("--tolerance <points>", "allowed decrease in percentage points", parseFloat, 0)
    .option("--subgraph <name...>", "apply the thresholds to these subgraphs instead of the whole schema; * for every subgraph")
    .option("--min-used-fields <pct>", "minimum share of fields with production traffic that are tested (report needs --usage)", parseFloat)
    .action((reportPath: string, o) => {
      const report = readReport(reportPath);
      const result = gate(report, {
        minFields: o.minFields,
        minInputFields: o.minInputFields,
        minEnumValues: o.minEnumValues,
        base: o.base ? readReport(o.base) : undefined,
        tolerance: o.tolerance,
        subgraphs: o.subgraph,
        minUsedFields: o.minUsedFields,
      });
      printSummary(report);
      if (result.passed) return console.log("  gate: passed");
      console.error("  gate: FAILED");
      for (const f of result.failures) console.error(`    - ${f}`);
      process.exitCode = 1;
    });

  return program;
}
