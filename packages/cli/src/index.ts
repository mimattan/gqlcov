import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { computeCoverage, diffReports, fmtRequests, gate, mergeReports, parsePersistedManifest, parseUsage, readCaptures, testCoverage, toMarkdown, uncovered, toIstanbul, toLcov, DEFAULT_CAPTURE_DIR, type CoverageReport } from "@gqlcov/core";
import { renderHtml } from "./html.js";
import { isRemotePointer as isRemote, loadSchema } from "./schema-source.js";
import { upsertPrComment } from "./github.js";
import { fetchApolloUsage, fetchCosmoUsage } from "./registry.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const readReport = (p: string): CoverageReport => JSON.parse(readFileSync(p, "utf8")) as CoverageReport;
const writeOut = (p: string, content: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

function printSummary(r: CoverageReport): void {
  const s = r.summary;
  const line = (label: string, x: { percent: number; covered: number; total: number }) => `  ${label.padEnd(38)} ${String(x.percent).padStart(6)}%  (${x.covered}/${x.total})`;
  console.log(`gqlcov: ${r.operations.total} operations (${r.operations.query} queries, ${r.operations.mutation} mutations, ${r.operations.subscription} subscriptions${r.operations.invalid ? `, ${r.operations.invalid} invalid` : ""}${r.operations.unresolved ? `, ${r.operations.unresolved} unresolved persisted ids` : ""}), schema ${r.schemaHash}`);
  console.log(line("Types", s.types));
  console.log(line("Output fields", s.fields));
  console.log(line("Arguments", s.arguments));
  console.log(line("Input-type fields sent", s.inputFields));
  console.log(line("Optional inputs sent and omitted", s.inputFieldsBothStates));
  console.log(line("Enum values sent", s.enumValues));
  // Older reports have no observed number.
  if (s.enumValuesObserved) console.log(line("Enum values in responses (not gated)", s.enumValuesObserved));
  if (r.usage) console.log(line("Production fields tested", r.usage.usedFields));
  if (r.usage?.usedInputs) console.log(line("Production inputs sent by a test", r.usage.usedInputs));
  printSubgraphs(r);
}


function printUsage(r: CoverageReport): void {
  const u = r.usage;
  if (!u) return;
  const where = [u.source, u.from && u.to ? `${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}` : undefined].filter(Boolean).join(", ");
  const inputs = u.usedInputs ? `, ${u.usedInputs.total} input fields and enum values with traffic, ${u.usedInputs.covered} sent by a test` : "";
  console.log(`\n  production usage${where ? ` (${where})` : ""}: ${u.usedFields.total} fields with traffic, ${u.usedFields.covered} tested${inputs}, ${u.testedUnused.length} tested without traffic, ${u.unusedUntested.length} neither`);
  if (u.untestedUsed.length) {
    console.log(`  used in production, never tested (${u.untestedUsed.length}):`);
    for (const x of u.untestedUsed.slice(0, 25)) console.log(`    ${x.path.padEnd(44)} ${fmtRequests(x.requests).padStart(8)} requests${x.kind === "field" ? "" : x.kind === "inputField" ? "  (input field)" : "  (enum value)"}`);
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
    .requiredOption("-s, --schema <pointer>", "SDL file, introspection JSON file, http(s) endpoint, apollo:graph@variant (APOLLO_KEY) or cosmo:[namespace/]graph (COSMO_API_KEY)")
    .option("-c, --captures <dir...>", "capture folder(s)", [DEFAULT_CAPTURE_DIR])
    .option("-o, --out <file>", "JSON report path", ".gqlcov/report.json")
    .option("--html <file>", "also write an HTML report")
    .option("--lcov <file>", "also write LCOV (Codecov, Coveralls, SonarQube, genhtml); lines map to the schema file")
    .option("--istanbul <file>", "also write Istanbul coverage-final.json (nyc, istanbul-merge, Jest tooling)")
    .option("--schema-out <file>", "where to write the SDL that lcov/istanbul refer to when --schema is not an SDL file", ".gqlcov/schema.graphql")
    .option("-H, --header <header...>", "header for endpoint introspection, e.g. 'Authorization: Bearer x'")
    .option("--exclude <pattern...>", "exclude patterns: Type, Type.field, Type.field(arg), Input.field; * wildcard")
    .option("--subgraph <name=file...>", "attribute elements to subgraphs from one SDL per subgraph (a composed supergraph needs no option: its @join__ directives are read)")
    .option("--usage <file>", "production field usage JSON (from gqlcov usage apollo|cosmo) to list used-but-untested fields")
    .option("--persisted <file...>", "persisted-operation manifest(s) (Apollo manifest, Relay map, or [{id, body}]) to resolve captures that only carry an id")
    .option("--include-deprecated", "count deprecated elements in totals")
    .option("--sha <sha>", "commit SHA for the run", process.env.GITHUB_SHA)
    .option("--branch <name>", "branch for the run", process.env.GITHUB_REF_NAME)
    .option("--untested", "print the uncovered list")
    .option("-q, --quiet", "no console summary")
    .action(async (o) => {
      const loaded = await loadSchema(o.schema, parseHeaders(o.header), version);
      const schema = loaded.schema;
      const ops = readCaptures(o.captures);
      const explicitSubgraphs = readSubgraphSdls(o.subgraph);
      const report = computeCoverage(schema, ops, {
        exclude: o.exclude,
        excludeDeprecated: !o.includeDeprecated,
        run: { sha: o.sha, branch: o.branch, finishedAt: new Date().toISOString() },
        subgraphSdls: Object.keys(explicitSubgraphs).length ? explicitSubgraphs : loaded.subgraphSdls,
        usage: o.usage ? parseUsage(readFileSync(o.usage, "utf8")) : undefined,
        persisted: (o.persisted as string[] | undefined)?.map((f) => parsePersistedManifest(readFileSync(f, "utf8"))),
      });
      writeOut(o.out, JSON.stringify(report, null, 2));
      if (o.html) writeOut(o.html, renderHtml(report, schema));
      if (o.lcov || o.istanbul) {
        // Line numbers must refer to a file the coverage service can show: the SDL file given, or one we write.
        const sdlPath: string = loaded.isSdlFile ? o.schema : o.schemaOut;
        if (!loaded.isSdlFile) writeOut(sdlPath, loaded.sdl);
        if (o.lcov) writeOut(o.lcov, toLcov(report, loaded.sdl, sdlPath));
        if (o.istanbul) writeOut(o.istanbul, JSON.stringify(toIstanbul(report, loaded.sdl, sdlPath)));
      }
      if (!o.quiet) {
        if (isRemote(o.schema)) console.log(`gqlcov: schema from ${loaded.label}${loaded.subgraphSdls ? `, ${Object.keys(loaded.subgraphSdls).length} subgraphs` : ""}`);
        printSummary(report);
        printUsage(report);
        if (ops.length === 0) console.log(`  (no captures found in ${o.captures.join(", ")})`);
        if (report.operations.unresolved) console.log(`  ${report.operations.unresolved} captures carried only a persisted id: pass the manifest with --persisted, or the capture layer's manifest option`);
        console.log(`  report: ${o.out}${o.html ? `, html: ${o.html}` : ""}${o.lcov ? `, lcov: ${o.lcov}` : ""}${o.istanbul ? `, istanbul: ${o.istanbul}` : ""}`);
        if (o.untested) {
          const u = uncovered(report);
          for (const [k, v] of Object.entries(u)) if (v.length) console.log(`\n  ${k} (${v.length}):\n    ${v.join("\n    ")}`);
        }
      }
    });

  const usage = program.command("usage").description("Fetch production field usage from a schema registry, for gqlcov report --usage");
  usage
    .command("apollo")
    .description("GraphOS Insights: operations that referenced each field (needs APOLLO_KEY)")
    .argument("<graph@variant>", "graph ref, variant defaults to current")
    .option("-o, --out <file>", "usage JSON path", ".gqlcov/usage.json")
    .option("--since <timestamp>", "ISO 8601, or seconds relative to now", "-2592000")
    .option("--metric <name>", "requests (operations referencing the field) or executions (estimated resolver executions)", "requests")
    .option("--limit <n>", "maximum fields", (v: string) => parseInt(v, 10), 20000)
    .action(async (ref: string, o) => {
      if (o.metric !== "requests" && o.metric !== "executions") throw new Error(`--metric must be requests or executions`);
      const data = await fetchApolloUsage(ref, { since: o.since, metric: o.metric, limit: o.limit, clientVersion: version });
      writeOut(o.out, JSON.stringify(data, null, 2));
      console.log(`gqlcov: ${Object.keys(data.fields).length} fields from ${data.source}, ${data.from?.slice(0, 10)} to ${data.to?.slice(0, 10)}: ${o.out}`);
    });
  usage
    .command("cosmo")
    .description("Cosmo analytics: requests per field of a federated graph (needs COSMO_API_KEY)")
    .argument("<[namespace/]graph>", "federated graph, namespace defaults to default")
    .option("-o, --out <file>", "usage JSON path", ".gqlcov/usage.json")
    .option("--range <hours>", "window in hours, counted back from now", (v: string) => parseInt(v, 10), 720)
    .option("--from <iso>", "window start (with --to; overrides --range)")
    .option("--to <iso>", "window end")
    .action(async (ref: string, o) => {
      const data = await fetchCosmoUsage(ref, { range: o.range, from: o.from, to: o.to });
      writeOut(o.out, JSON.stringify(data, null, 2));
      console.log(`gqlcov: ${Object.keys(data.fields).length} fields from ${data.source}, ${data.from?.slice(0, 10)} to ${data.to?.slice(0, 10)}: ${o.out}`);
    });

  program
    .command("markdown")
    .description("Markdown summary for a pull request comment or job summary; with --base, the change and what was lost")
    .argument("<report>", "report JSON")
    .option("--base <report>", "base report to compare against (a missing file is ignored, for the first run)")
    .option("-o, --out <file>", "write to a file instead of printing")
    .action((reportPath: string, o) => {
      const base = o.base && existsSync(o.base) ? readReport(o.base) : undefined;
      const md = toMarkdown(readReport(reportPath), base);
      if (o.out) writeOut(o.out, md);
      else console.log(md);
    });

  program
    .command("comment")
    .description("Create or update gqlcov's comment on the current pull request (GitHub Actions)")
    .argument("<file>", "Markdown file, e.g. from gqlcov markdown")
    .option("--id <name>", "keep a separate comment per id, for several reports on one pull request")
    .option("--token <token>", "GitHub token (default GITHUB_TOKEN)")
    .option("--repo <owner/name>", "repository (default GITHUB_REPOSITORY)")
    .option("--pr <number>", "pull request number (default: from the GitHub Actions event)", (v: string) => parseInt(v, 10))
    .action(async (file: string, o) => {
      const r = await upsertPrComment({ body: readFileSync(file, "utf8"), id: o.id, token: o.token, repo: o.repo, pr: o.pr });
      console.log(r.action === "skipped" ? `gqlcov: comment skipped: ${r.reason}` : `gqlcov: comment ${r.action}: ${r.url}`);
    });

  program
    .command("tests")
    .description("Coverage per test, from the source label each capture carries")
    .argument("<report>", "report JSON")
    .option("--test <name>", "list everything one test covers")
    .option("--json", "print as JSON")
    .action((reportPath: string, o) => {
      const list = testCoverage(readReport(reportPath));
      const one = o.test === undefined ? undefined : list.find((t) => t.name === o.test);
      if (o.test !== undefined && !one) throw new Error(`no test named "${o.test}" in the report${list.length ? ` (tests: ${list.map((t) => t.name).join(", ")})` : ""}`);
      if (o.json) return console.log(JSON.stringify(one ?? list, null, 2));
      if (one) {
        console.log(`${one.name}: ${one.operations} operations`);
        const show = (title: string, items: string[]) => console.log(`\n  ${title} (${items.length})${items.length ? `:\n    ${items.join("\n    ")}` : ""}`);
        show("covered by this test only", one.unique);
        show("fields", one.fields);
        show("arguments", one.arguments);
        show("input fields", one.inputFields);
        show("enum values", one.enumValues);
        return;
      }
      if (!list.length) return console.log("gqlcov: the report has no test names. Give captures a source label (the capture plugins' source option).");
      const w = Math.max(4, ...list.map((t) => t.name.length));
      console.log(`  ${"Test".padEnd(w)}  ${"Ops".padStart(5)}  ${"Fields".padStart(6)}  ${"Args".padStart(5)}  ${"Inputs".padStart(6)}  ${"Enums".padStart(5)}  ${"Only".padStart(5)}`);
      for (const t of list) console.log(`  ${t.name.padEnd(w)}  ${String(t.operations).padStart(5)}  ${String(t.fields.length).padStart(6)}  ${String(t.arguments.length).padStart(5)}  ${String(t.inputFields.length).padStart(6)}  ${String(t.enumValues.length).padStart(5)}  ${String(t.unique.length).padStart(5)}`);
      const redundant = list.filter((t) => t.unique.length === 0);
      if (redundant.length) console.log(`\n  ${redundant.length} of ${list.length} tests cover nothing the others do not ("Only" is 0).`);
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
    .option("--base <report>", "fail on any decrease versus this report (a missing file skips this check, for the first run)")
    .option("--tolerance <points>", "allowed decrease in percentage points", parseFloat, 0)
    .option("--subgraph <name...>", "apply the thresholds to these subgraphs instead of the whole schema; * for every subgraph")
    .option("--min-used-fields <pct>", "minimum share of fields with production traffic that are tested (report needs --usage)", parseFloat)
    .option("--min-used-inputs <pct>", "minimum share of input fields and enum values with production traffic that a test sent (usage must cover inputs)", parseFloat)
    .action((reportPath: string, o) => {
      const report = readReport(reportPath);
      const baseMissing = o.base !== undefined && !existsSync(o.base);
      if (baseMissing) console.log(`  base report ${o.base} not found: skipping the no-decrease check`);
      const result = gate(report, {
        minFields: o.minFields,
        minInputFields: o.minInputFields,
        minEnumValues: o.minEnumValues,
        base: o.base && !baseMissing ? readReport(o.base) : undefined,
        tolerance: o.tolerance,
        subgraphs: o.subgraph,
        minUsedFields: o.minUsedFields,
        minUsedInputs: o.minUsedInputs,
      });
      printSummary(report);
      if (result.passed) return console.log("  gate: passed");
      console.error("  gate: FAILED");
      for (const f of result.failures) console.error(`    - ${f}`);
      process.exitCode = 1;
    });

  return program;
}
