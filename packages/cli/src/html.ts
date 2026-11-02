import { getNamedType, isListType, isNonNullType, isObjectType, type GraphQLObjectType, type GraphQLSchema } from "graphql";
import { fmtRequests, testCoverage, type CoverageReport, type EnumValueCoverage, type Ratio } from "@gqlcov/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (c: number, t: number) => (t === 0 ? 100 : Math.round((c / t) * 1000) / 10);
const cls = (p: number) => (p >= 80 ? "good" : p >= 40 ? "mid" : p > 0 ? "low" : "none");

function ledger(label: string, r: Ratio, note: string): string {
  return `<div class="ledger-row"><div class="ledger-head"><span class="ledger-label">${esc(label)}<small>${esc(note)}</small></span><span class="ledger-num ${cls(r.percent)}">${r.percent}<span class="unit">%</span></span></div><div class="track"><span class="fill ${cls(r.percent)}" style="width:${r.percent}%"></span></div><div class="ledger-sub">${r.covered} of ${r.total}</div></div>`;
}

function miniBar(covered: number, total: number): string {
  const p = pct(covered, total);
  return `<span class="mini"><span class="mini-track"><span class="fill ${cls(p)}" style="width:${p}%"></span></span><span class="mini-num">${covered}/${total}</span></span>`;
}

interface Row { name: string; covered: number; total: number; body: string; kind: string; uncovered: boolean; graphs?: string[] }
const gAttr = (graphs?: string[]) => (graphs ? ` data-g="${esc(graphs.join(" "))}"` : "");
/** Test names on a list item: searchable through data-t, readable in a short label with the full list on hover. */
const tAttr = (tests?: string[]) => (tests ? ` data-t="${esc(tests.join("\n").toLowerCase())}"` : "");
const byTests = (tests?: string[]) => (tests ? `<span class="by" title="Covered by: ${esc(tests.join(", "))}">${esc(tests[0])}${tests.length > 1 ? ` +${tests.length - 1}` : ""}</span>` : "");

/** A row for an object or interface type; callers only pass types the report has. */
function typeRow(report: CoverageReport, tn: string, label?: string): Row {
  const t = report.types[tn];
  const fields = Object.entries(t.fields);
  const covered = fields.filter(([, f]) => f.hits > 0).length;
  const lines = fields
    .map(([fn, f]) => {
      const args = Object.entries(f.args);
      const argText = args.length ? `<span class="args">(${args.map(([an, a]) => `<span class="${a.hits > 0 ? "on" : "off"}" title="${a.hits} hits${a.tests ? `: ${esc(a.tests.join(", "))}` : ""}">${esc(an)}</span>`).join(", ")})</span>` : "";
      const prod = f.requests !== undefined ? `<span class="prod${f.requests > 0 && f.hits === 0 ? " risk" : ""}" title="production requests in the usage window">${f.requests > 0 ? `${fmtRequests(f.requests)} in prod` : "no prod traffic"}</span>` : "";
      return `<li class="${f.hits > 0 ? "on" : "off"}" data-n="${esc(fn.toLowerCase())}"${gAttr(f.graphs)}${tAttr(f.tests)}><span class="fname">${esc(fn)}${argText}</span><span class="hits">${byTests(f.tests)}${prod}${f.hits > 0 ? `${f.hits}×` : "never"}</span></li>`;
    })
    .join("");
  return { name: label ?? tn, covered, total: fields.length, body: `<ul class="fields">${lines}</ul>`, kind: t.kind === "INTERFACE" ? "interface" : "type", uncovered: covered < fields.length, graphs: t.graphs };
}

function inputRow(report: CoverageReport, tn: string): Row {
  const t = report.inputTypes[tn];
  const fields = Object.entries(t.fields);
  const covered = fields.filter(([, f]) => f.sent > 0).length;
  const lines = fields
    .map(([fn, f]) => {
      const state = f.sent === 0 ? "off" : !f.required && f.omitted === 0 ? "half" : "on";
      const detail = f.sent === 0 ? "never sent" : `sent ${f.sent}${f.required ? "" : `, omitted ${f.omitted}`}${f.values.null ? `, null ${f.values.null}` : ""}`;
      return `<li class="${state}" data-n="${esc(fn.toLowerCase())}"${gAttr(f.graphs)}${tAttr(f.tests)}><span class="fname">${esc(fn)}${f.required ? "<span class='req'>!</span>" : ""}</span><span class="hits">${byTests(f.tests)}${detail}</span></li>`;
    })
    .join("");
  return { name: tn, covered, total: fields.length, body: `<ul class="fields">${lines}</ul>`, kind: "input", uncovered: covered < fields.length, graphs: t.graphs };
}

/** Input-reachable enums are scored on values sent; output-only enums on values seen in responses. */
function enumRow(report: CoverageReport, en: string): Row {
  const e = report.enums[en];
  const input = e.input ?? true;
  const values = Object.entries(e.values);
  const isOn = (v: EnumValueCoverage) => (input ? v.hits > 0 : v.observed > 0); // output-only enums exist only in reports that count observed
  const covered = values.filter(([, v]) => isOn(v)).length;
  const detail = (v: EnumValueCoverage) => {
    const parts = [input ? (v.hits > 0 ? `sent ${v.hits}` : "never sent") : "", e.output ? (v.observed ? `in ${v.observed} responses` : "not seen in responses") : ""];
    return parts.filter(Boolean).join(", ");
  };
  const lines = values.map(([vn, v]) => `<li class="${isOn(v) ? "on" : "off"}" data-n="${esc(vn.toLowerCase())}"${gAttr(v.graphs)}${tAttr(v.tests)}><span class="fname">${esc(vn)}</span><span class="hits">${byTests(v.tests)}${detail(v)}</span></li>`).join("");
  return { name: en, covered, total: values.length, body: `<ul class="fields">${lines}</ul>`, kind: input ? "enum" : "out enum", uncovered: covered < values.length, graphs: e.graphs };
}

function renderRow(r: Row): string {
  return `<details class="row ${r.uncovered ? "has-gap" : "full"}" data-n="${esc(r.name.toLowerCase())}"${gAttr(r.graphs)}><summary><div class="sum"><span class="rname"><span class="kind">${r.kind}</span>${esc(r.name)}</span>${miniBar(r.covered, r.total)}</div></summary>${r.body}</details>`;
}

/** Root operation types and the namespace objects their fields return, e.g. Query.competition -> CompetitionQueries. */
/** Root operation types and the namespace objects their fields return, e.g. Query.competition -> CompetitionQueries.
 *  A namespace is a root field with no arguments returning a single (non-list) object type that no other field in the schema references. */
function rootSections(report: CoverageReport, schema?: GraphQLSchema): string {
  const roots = ["Query", "Mutation", "Subscription"].filter((n) => report.types[n]);
  const refs = new Map<string, number>();
  if (schema) {
    for (const t of Object.values(schema.getTypeMap())) {
      if (!isObjectType(t) || roots.includes(t.name)) continue;
      for (const f of Object.values(t.getFields())) {
        const n = getNamedType(f.type).name;
        refs.set(n, (refs.get(n) ?? 0) + 1);
      }
    }
  }
  return roots
    .map((root) => {
      const rt = schema?.getType(root) as GraphQLObjectType | undefined; // root operation types are object types
      const rows: string[] = [];
      const grouped = new Set<string>();
      if (rt) {
        for (const f of Object.values(rt.getFields())) {
          if (!report.types[root].fields[f.name]) continue; // excluded root field
          const inner = isNonNullType(f.type) ? f.type.ofType : f.type;
          const named = getNamedType(f.type);
          const isNamespace = !isListType(inner) && f.args.length === 0 && isObjectType(named) && named.name !== root && !!report.types[named.name] && (refs.get(named.name) ?? 0) === 0;
          if (!isNamespace) continue;
          rows.push(renderRow(typeRow(report, named.name, `${root}.${f.name}`)));
          grouped.add(f.name);
        }
      }
      const total = Object.keys(report.types[root].fields).length;
      let direct = "";
      if (grouped.size < total) {
        const t = report.types[root];
        const rest = Object.fromEntries(Object.entries(t.fields).filter(([fn]) => !grouped.has(fn)));
        const tmp: CoverageReport = { ...report, types: { ...report.types, [root]: { ...t, fields: rest } } };
        direct = renderRow(typeRow(tmp, root, grouped.size ? `${root} (direct fields)` : root));
      }
      return `<section><h2>${esc(root)} <span class="h2-note">${total} root fields</span></h2>${rows.length ? `<p class="hint">Grouped by namespace: each row is a root field and the fields of the type it returns.</p>` : ""}${rows.join("")}${direct}</section>`;
    })
    .join("");
}

function usageSection(report: CoverageReport): string {
  const u = report.usage;
  if (!u) return "";
  const where = [u.source, u.from && u.to ? `${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}` : undefined].filter((x): x is string => !!x).map(esc).join(", ");
  const risk = u.untestedUsed.length
    ? `<ul class="fields">${u.untestedUsed.map((x) => `<li class="off"><span class="fname">${esc(x.path)}</span><span class="hits"><span class="prod risk">${fmtRequests(x.requests)} requests</span>never tested</span></li>`).join("")}</ul>`
    : `<p class="empty">Every field with production traffic was requested by a test.</p>`;
  const list = (title: string, items: string[]) => items.length ? `<details class="row aux"><summary><div class="sum"><span class="rname">${title}</span><span class="mini-num">${items.length}</span></div></summary><ul class="fields">${items.map((p) => `<li class="off"><span class="fname">${esc(p)}</span></li>`).join("")}</ul></details>` : "";
  return `<section class="usage"><h2>Production usage <span class="h2-note">${where}</span></h2><p class="hint">${u.usedFields.total} fields had production traffic; ${u.usedFields.covered} of them were requested by a test.</p><div class="row risk-box"><div class="risk-head">Used in production, never tested <span class="h2-note">${u.untestedUsed.length}</span></div>${risk}</div>${list("Tested, no production traffic", u.testedUnused)}${list("No traffic and no test: deprecation candidates", u.unusedUntested)}${list("In usage data but not in the schema", u.unknown)}</section>`;
}

function testsSection(report: CoverageReport): string {
  const list = testCoverage(report);
  if (!list.length) return "";
  const rows = list.map((t) => {
    const covered = t.fields.length + t.arguments.length + t.inputFields.length + t.enumValues.length;
    const unique = t.unique.length ? `<ul class="fields">${t.unique.map((p) => `<li class="on"><span class="fname">${esc(p)}</span><span class="hits">only this test</span></li>`).join("")}</ul>` : `<p class="empty">Covers nothing the other tests do not.</p>`;
    return `<details class="row aux ${t.unique.length ? "" : "redundant"}"><summary><div class="sum"><span class="rname">${esc(t.name)}</span><span class="hits">${t.operations} ops, ${covered} covered, ${t.unique.length} only here</span></div></summary>${unique}</details>`;
  });
  return `<section class="tests"><h2>Tests <span class="h2-note">${list.length}</span></h2><p class="hint">From the source label on each capture. "Only here" lists what no other test covers; type a test name in the filter to see everything it touches.</p>${rows.join("")}</section>`;
}

function subgraphTable(report: CoverageReport): string {
  const names = Object.keys(report.subgraphs ?? {});
  if (!names.length) return "";
  const cell = (r: Ratio) => `<td><span class="mini"><span class="mini-track"><span class="fill ${cls(r.percent)}" style="width:${r.percent}%"></span></span><span class="mini-num">${r.percent}%</span></span><small>${r.covered}/${r.total}</small></td>`;
  const rows = names.map((n) => {
    const g = report.subgraphs![n];
    return `<tr><th scope="row"><button type="button" class="sg-pick" data-sg="${esc(n)}">${esc(n)}</button></th>${cell(g.fields)}${cell(g.arguments)}${cell(g.inputFields)}${cell(g.enumValues)}</tr>`;
  });
  return `<section class="subgraphs"><h2>Subgraphs <span class="h2-note">${names.length}</span></h2><p class="hint">Shared types and fields count in every subgraph that defines them. Click a name to filter the report.</p><table class="sg"><thead><tr><th>Subgraph</th><th>Output fields</th><th>Arguments</th><th>Input fields</th><th>Enum values</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
}

export function renderHtml(report: CoverageReport, schema?: GraphQLSchema): string {
  const s = report.summary;
  const subgraphNames = Object.keys(report.subgraphs ?? {});
  const ops = report.operations;
  const rootNames = new Set(["Query", "Mutation", "Subscription"]);
  const typeRows = Object.keys(report.types).filter((n) => !rootNames.has(n)).sort().map((n) => renderRow(typeRow(report, n))).join("");
  const inputRows = Object.keys(report.inputTypes).sort().map((n) => renderRow(inputRow(report, n))).join("");
  const enumRows = Object.keys(report.enums).sort().map((n) => renderRow(enumRow(report, n))).join("");
  const named = Object.entries(ops.named).sort((a, b) => b[1] - a[1]);
  const meta = [
    report.run?.branch && esc(report.run.branch),
    report.run?.sha && `commit ${esc(report.run.sha.slice(0, 10))}`,
    `schema ${esc(report.schemaHash)}`,
    `generated ${esc(report.generatedAt.replace("T", " ").slice(0, 16))} UTC`,
  ].filter(Boolean).join(" &nbsp;/&nbsp; ");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gqlcov: schema coverage</title>
<style>
:root{color-scheme:light dark;--bg:#f7f8f6;--panel:#fff;--ink:#1d2320;--ink2:#5b645f;--line:#dfe3df;--track:#e6e9e6;--good:#2f7d4f;--mid:#b07a12;--low:#b4472b;--none:#8a9490;--on-bg:#e4f1e8;--half-bg:#f7ecd2;--off-bg:transparent;--accent:#1f5f8b}
@media(prefers-color-scheme:dark){:root{--bg:#161a18;--panel:#1e2421;--ink:#e6e9e6;--ink2:#9aa39e;--line:#2d3531;--track:#2a312d;--good:#5fbe85;--mid:#d9a23b;--low:#e0674a;--none:#6d7672;--on-bg:#1f3b2a;--half-bg:#4a3a14;--accent:#6ba8d6}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
main{max-width:860px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:26px;font-weight:650;letter-spacing:-.01em;margin:0 0 6px}
.meta{color:var(--ink2);font-size:13px;margin:0 0 4px}
.ops{color:var(--ink2);font-size:14px;margin:0 0 28px}.ops b{color:var(--ink);font-weight:600}
.ledger{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 20px 14px;margin-bottom:36px}
.ledger-row{padding:14px 0 10px;border-bottom:1px solid var(--line)}.ledger-row:last-child{border-bottom:0}
.ledger-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.ledger-label{font-weight:550}.ledger-label small{display:block;font-weight:400;color:var(--ink2);font-size:12.5px}
.ledger-num{font-size:30px;font-weight:650;line-height:1;letter-spacing:-.02em}.ledger-num .unit{font-size:16px;font-weight:500;margin-left:1px}
.ledger-sub{color:var(--ink2);font-size:12.5px;margin-top:6px}
.track{height:8px;background:var(--track);border-radius:4px;overflow:hidden;margin-top:10px}.fill{display:block;height:100%;min-width:0;border-radius:4px}
.fill.good,.ledger-num.good{color:var(--good)}.fill.good{background:var(--good)}.fill.mid{background:var(--mid)}.ledger-num.mid{color:var(--mid)}.fill.low{background:var(--low)}.ledger-num.low{color:var(--low)}.fill.none{background:var(--none)}.ledger-num.none{color:var(--none)}
.toolbar{position:sticky;top:0;z-index:2;background:var(--bg);padding:10px 0 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:8px}
.toolbar input[type=search]{flex:1 1 220px;min-width:0;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit}
.toolbar label{display:flex;align-items:center;gap:6px;color:var(--ink2);font-size:13.5px;white-space:nowrap}
.toolbar button{font:inherit;font-size:13px;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);cursor:pointer}
h2{font-size:17px;font-weight:650;margin:30px 0 8px}.h2-note{color:var(--ink2);font-weight:400;font-size:14px;margin-left:6px}
.hint{color:var(--ink2);font-size:13px;margin:0 0 10px}
.row{border:1px solid var(--line);border-radius:8px;background:var(--panel);margin:0 0 6px}
.row summary{list-style:none;padding:10px 14px;cursor:pointer}.sum{display:flex;justify-content:space-between;align-items:center;gap:14px}.rname{flex:1 1 auto}.mini{flex:0 0 150px}.row summary::-webkit-details-marker{display:none}
.row summary::before{content:"";display:none}
.rname{font-weight:550;overflow-wrap:anywhere}.kind{display:inline-block;color:var(--ink2);font-weight:400;font-size:12px;width:62px}
.mini{display:flex;align-items:center;gap:8px;width:150px}.mini-track{flex:1;height:6px;background:var(--track);border-radius:3px;overflow:hidden}.mini-num{color:var(--ink2);font-size:12.5px;width:60px;text-align:right}
.fields{list-style:none;margin:0;padding:4px 14px 10px;border-top:1px solid var(--line)}
.fields li{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:13.5px}.fields li:last-child{border-bottom:0}
.fname{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere}.hits{color:var(--ink2);font-size:12.5px;white-space:nowrap}
li.on .fname{color:var(--good)}li.half .fname{color:var(--mid)}li.off .fname{color:var(--ink)}
.args{color:var(--ink2)}.args .on{color:var(--good)}.args .off{color:var(--ink2)}.req{color:var(--low);margin-left:1px}
.legend{color:var(--ink2);font-size:12.5px;margin:0 0 10px}
body.only-gaps .row.full:not(.aux),body.only-gaps li.on{display:none}
.hidden{display:none!important}
.empty{color:var(--ink2);font-size:14px;padding:12px 0}
.prod{display:inline-block;margin-right:10px;padding:1px 7px;border-radius:10px;background:var(--track);color:var(--ink2);font-size:11.5px}.prod.risk{background:var(--low);color:#fff}
.usage{margin-bottom:28px}.risk-box{padding:0}.risk-head{padding:10px 14px;font-weight:550}.risk-box .fields{border-top:1px solid var(--line)}
.by{display:inline-block;margin-right:10px;color:var(--accent);font-size:11.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
.tests .row.redundant .rname{color:var(--ink2)}
.subgraphs{margin-bottom:28px}.sg{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;font-size:13.5px}
.sg th,.sg td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:middle}.sg tbody tr:last-child td,.sg tbody tr:last-child th{border-bottom:0}.sg thead th{color:var(--ink2);font-weight:500;font-size:12.5px}
.sg td .mini{width:auto;min-width:120px}.sg td small{display:block;color:var(--ink2);font-size:11.5px}.sg-pick{font:inherit;font-weight:550;background:none;border:0;padding:0;color:var(--accent);cursor:pointer;text-align:left}
.toolbar select{font:inherit;font-size:13.5px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}
@media(max-width:640px){.sg thead{display:none}.sg tr{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;padding:8px 12px;border-bottom:1px solid var(--line)}.sg th,.sg td{border:0;padding:2px 0}.sg th{grid-column:1/-1}}
@media(max-width:520px){main{padding:20px 14px 60px}h1{font-size:22px}.ledger{padding:4px 14px 10px}.ledger-num{font-size:26px}.row summary{padding:10px 12px}.sum{flex-wrap:wrap;gap:6px}.mini{flex:1 1 100%}.kind{width:auto;margin-right:8px}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body>
<main>
<h1>GraphQL schema coverage</h1>
<p class="meta">${meta}</p>
<p class="ops">${ops.total === 0 ? "<b>No operations captured.</b> Every number below is 0; the lists show the full schema surface." : `<b>${ops.total}</b> operations captured: ${ops.query} queries, ${ops.mutation} mutations, ${ops.subscription} subscriptions${ops.invalid ? `, <b>${ops.invalid} invalid</b>` : ""}.`}</p>

<div class="ledger">
${ledger("Output fields", s.fields, "requested at least once")}
${ledger("Arguments", s.arguments, "passed at least once")}
${ledger("Input fields", s.inputFields, "sent at least once")}
${ledger("Optional input fields, both states", s.inputFieldsBothStates, "seen sent and seen omitted")}
${ledger("Enum values", s.enumValues, "sent as input at least once; enums a client can send")}
${s.enumValuesObserved ? ledger("Enum values in responses", s.enumValuesObserved, "returned at least once; informational, never gated") : ""}
${ledger("Types", s.types, "touched by any operation")}
${report.usage ? ledger("Production fields tested", report.usage.usedFields, "fields with production traffic that a test requested") : ""}
</div>
${usageSection(report)}

${subgraphTable(report)}
<div class="toolbar"><input type="search" id="q" placeholder="Filter types, fields, values, tests…" aria-label="Filter">${subgraphNames.length ? `<select id="sg" aria-label="Subgraph"><option value="">All subgraphs</option>${subgraphNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>` : ""}<label><input type="checkbox" id="gaps"> uncovered only</label><button type="button" id="expand">Expand all</button><button type="button" id="collapse">Collapse</button></div>

${rootSections(report, schema)}

<section><h2>All types <span class="h2-note">${Object.keys(report.types).length - [...rootNames].filter((n) => report.types[n]).length}</span></h2>${typeRows}</section>
<section><h2>Input types <span class="h2-note">${Object.keys(report.inputTypes).length}</span></h2><p class="legend">Green: sent, and omitted too where optional. Amber: sent but never omitted. Plain: never sent. ! marks required fields.</p>${inputRows}</section>
<section><h2>Enums <span class="h2-note">${Object.keys(report.enums).length}</span></h2><p class="legend">Enums a client can send are scored on values sent. Output-only enums ("out enum") are scored on values seen in responses and do not count toward the enum-values number.</p>${enumRows}</section>
${testsSection(report)}
<section><h2>Operations <span class="h2-note">${named.length}</span></h2>${named.length ? `<ul class="fields" style="border:1px solid var(--line);border-radius:8px;background:var(--panel)">${named.map(([n, c]) => `<li class="on"><span class="fname">${esc(n)}</span><span class="hits">${c}×</span></li>`).join("")}</ul>` : `<p class="empty">No operations in this run.</p>`}</section>
</main>
<script>
(function(){
  var q=document.getElementById('q'),gaps=document.getElementById('gaps'),sg=document.getElementById('sg'),rows=[].slice.call(document.querySelectorAll('details.row:not(.aux)'));
  function inGraph(el,g){if(!g)return true;var d=el.dataset.g;return !!d&&(' '+d+' ').indexOf(' '+g+' ')>=0;}
  function apply(){
    var term=q.value.trim().toLowerCase(),g=sg?sg.value:'';
    rows.forEach(function(r){
      var hit=!term||r.dataset.n.indexOf(term)>=0;
      var items=r.querySelectorAll('li');
      var any=false,tot=0,cov=0;
      for(var i=0;i<items.length;i++){var ig=inGraph(items[i],g);var m=ig&&(!term||hit||items[i].dataset.n.indexOf(term)>=0||(items[i].dataset.t||'').indexOf(term)>=0);items[i].classList.toggle('hidden',!m);if(m)any=true;if(ig){tot++;if(items[i].classList.contains('on'))cov++;}}
      r.classList.toggle('hidden',!(hit||any)||(!!g&&tot===0));
      if(term&&!hit&&any)r.open=true;
      if(g!==undefined){var num=r.querySelector('.mini-num'),fill=r.querySelector('.mini .fill');if(num&&fill){var p=tot===0?100:Math.round(cov/tot*1000)/10;num.textContent=cov+'/'+tot;fill.style.width=p+'%';fill.className='fill '+(p>=80?'good':p>=40?'mid':p>0?'low':'none');}}
    });
    document.querySelectorAll('section').forEach(function(sec){var vis=sec.querySelector('details.row:not(.hidden)');sec.classList.toggle('hidden',!vis&&sec.querySelector('details.row')!==null);});
  }
  q.addEventListener('input',apply);
  if(sg){sg.addEventListener('change',apply);[].forEach.call(document.querySelectorAll('.sg-pick'),function(b){b.addEventListener('click',function(){sg.value=b.dataset.sg;apply();document.querySelector('.toolbar').scrollIntoView({behavior:'smooth'});});});}
  gaps.addEventListener('change',function(){document.body.classList.toggle('only-gaps',gaps.checked);});
  document.getElementById('expand').addEventListener('click',function(){rows.forEach(function(r){if(!r.classList.contains('hidden'))r.open=true;});});
  document.getElementById('collapse').addEventListener('click',function(){rows.forEach(function(r){r.open=false;});});
})();
</script>
</body></html>`;
}
