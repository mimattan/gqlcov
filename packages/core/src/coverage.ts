import {
  getNamedType,
  getNullableType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isUnionType,
  Kind,
  parse,
  TypeInfo,
  validate,
  valueFromASTUntyped,
  visit,
  visitWithTypeInfo,
  type GraphQLInputType,
  type OperationDefinitionNode,
} from "graphql";
import { Excluder } from "./exclude.js";
import { schemaHash, toSchema } from "./schema.js";
import { attributeSubgraphs, subgraphsFromSdls, subgraphsFromSupergraph } from "./subgraphs.js";
import { applyUsage } from "./usage.js";
import { addInvalid } from "./invalid.js";
import { resolvePersisted, type PersistedManifest } from "./persisted.js";
import type {
  AbstractTypeCoverage,
  CapturedOperation,
  CoverageOptions,
  CoverageReport,
  CoverageSummary,
  EnumCoverage,
  InputTypeCoverage,
  Ratio,
  RunInfo,
  TypeCoverage,
  UsageData,
  ValueClasses,
} from "./types.js";
import { classifyValue, emptyValueClasses } from "./values.js";

function ratio(covered: number, total: number): Ratio {
  return { covered, total, percent: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100 };
}

/** Build a report with every included schema element at zero. */
export function emptyReport(schemaInput: string | object | GraphQLSchema, options: CoverageOptions = {}): CoverageReport {
  const schema = toSchema(schemaInput);
  const ex = new Excluder(options);
  const types: Record<string, TypeCoverage> = {};
  const inputTypes: Record<string, InputTypeCoverage> = {};
  const enums: Record<string, EnumCoverage> = {};
  const argumentValues: Record<string, ValueClasses> = {};

  for (const type of Object.values(schema.getTypeMap())) {
    if (ex.isExcluded(type.name)) continue;
    if (isObjectType(type) || isInterfaceType(type)) {
      const tc: TypeCoverage = { kind: isObjectType(type) ? "OBJECT" : "INTERFACE", hits: 0, fields: {} };
      for (const field of Object.values(type.getFields())) {
        const fpath = `${type.name}.${field.name}`;
        const fdep = field.deprecationReason != null;
        if (ex.isExcluded(fpath, fdep)) continue;
        tc.fields[field.name] = { hits: 0, deprecated: fdep, args: {} };
        for (const arg of field.args) {
          const apath = `${fpath}(${arg.name})`;
          const adep = arg.deprecationReason != null;
          if (ex.isExcluded(apath, adep)) continue;
          tc.fields[field.name].args[arg.name] = { hits: 0, deprecated: adep };
          argumentValues[apath] = emptyValueClasses();
        }
      }
      types[type.name] = tc;
    } else if (isInputObjectType(type)) {
      const ic: InputTypeCoverage = { hits: 0, fields: {} };
      for (const field of Object.values(type.getFields())) {
        const fpath = `${type.name}.${field.name}`;
        const fdep = field.deprecationReason != null;
        if (ex.isExcluded(fpath, fdep)) continue;
        ic.fields[field.name] = {
          sent: 0,
          omitted: 0,
          deprecated: fdep,
          required: isNonNullType(field.type) && field.defaultValue === undefined,
          values: emptyValueClasses(),
        };
      }
      inputTypes[type.name] = ic;
    } else if (isEnumType(type)) {
      const ec: EnumCoverage = { input: false, output: false, values: {} };
      for (const v of type.getValues()) {
        const vdep = v.deprecationReason != null;
        if (ex.isExcluded(`${type.name}.${v.name}`, vdep)) continue;
        ec.values[v.name] = { hits: 0, observed: 0, deprecated: vdep };
      }
      enums[type.name] = ec;
    }
  }
  markEnumReachability(schema, types, inputTypes, enums);
  const abstractTypes: Record<string, AbstractTypeCoverage> = {};
  for (const type of Object.values(schema.getTypeMap())) {
    if ((!isInterfaceType(type) && !isUnionType(type)) || ex.isExcluded(type.name)) continue;
    const possible = schema.getPossibleTypes(type).filter((t) => types[t.name]);
    abstractTypes[type.name] = { kind: isUnionType(type) ? "UNION" : "INTERFACE", seen: 0, possible: Object.fromEntries(possible.map((t) => [t.name, 0])) };
  }

  const report: CoverageReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    schemaHash: schemaHash(schema),
    options: { excludeDeprecated: ex.excludeDeprecated, exclude: options.exclude ?? [] },
    operations: { total: 0, query: 0, mutation: 0, subscription: 0, named: {}, invalid: 0 },
    summary: summarise({ types, inputTypes, enums }),
    types,
    inputTypes,
    enums,
    argumentValues,
    abstractTypes,
  };
  return report;
}

/**
 * Flag each enum as reachable as input (from an included argument, directly or through included input fields)
 * and as output (the type of an included output field). Output-only enums can never be covered by sending,
 * so they are left out of `enumValues` and reported under `enumValuesObserved` instead.
 */
function markEnumReachability(
  schema: GraphQLSchema,
  types: Record<string, TypeCoverage>,
  inputTypes: Record<string, InputTypeCoverage>,
  enums: Record<string, EnumCoverage>,
): void {
  const queue: string[] = [];
  const seen = new Set<string>();
  const reach = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    queue.push(name);
  };
  for (const [tn, tc] of Object.entries(types)) {
    // `types` holds only the schema's object and interface types, with fields taken from it.
    const defs = (schema.getType(tn) as GraphQLObjectType | GraphQLInterfaceType).getFields();
    for (const [fn, fc] of Object.entries(tc.fields)) {
      const def = defs[fn];
      const out = enums[getNamedType(def.type).name];
      if (out) out.output = true;
      for (const arg of def.args) if (fc.args[arg.name]) reach(getNamedType(arg.type).name);
    }
  }
  while (queue.length) {
    const name = queue.pop()!;
    if (enums[name]) {
      enums[name].input = true;
      continue;
    }
    const type = schema.getType(name);
    const ic = inputTypes[name];
    if (!ic || !isInputObjectType(type)) continue;
    for (const field of Object.values(type.getFields())) if (ic.fields[field.name]) reach(getNamedType(field.type).name);
  }
}

/** Summarise the report, or only the elements tagged with one subgraph when `graph` is given. */
export function summarise(r: Pick<CoverageReport, "types" | "inputTypes" | "enums">, graph?: string): CoverageSummary {
  const inGraph = (x: { graphs?: string[] }) => graph === undefined || (x.graphs?.includes(graph) ?? false);
  let tC = 0, tT = 0, fC = 0, fT = 0, aC = 0, aT = 0, iC = 0, iT = 0, bC = 0, bT = 0, eC = 0, eT = 0, oC = 0, oT = 0;
  for (const t of Object.values(r.types)) {
    if (inGraph(t)) {
      tT++;
      if (t.hits > 0) tC++;
    }
    for (const f of Object.values(t.fields)) {
      if (!inGraph(f)) continue;
      fT++;
      if (f.hits > 0) fC++;
      for (const a of Object.values(f.args)) {
        aT++;
        if (a.hits > 0) aC++;
      }
    }
  }
  for (const it of Object.values(r.inputTypes)) {
    for (const f of Object.values(it.fields)) {
      if (!inGraph(f)) continue;
      iT++;
      if (f.sent > 0) iC++;
      if (!f.required) {
        bT++;
        if (f.sent > 0 && f.omitted > 0) bC++;
      }
    }
  }
  for (const e of Object.values(r.enums)) {
    // Reports written before the input/output split carry neither flag: count them as input, as they were.
    const input = e.input ?? true;
    for (const v of Object.values(e.values)) {
      if (!inGraph(v)) continue;
      if (input) {
        eT++;
        if (v.hits > 0) eC++;
      }
      if (e.output) {
        oT++;
        if (v.observed > 0) oC++;
      }
    }
  }
  return {
    types: ratio(tC, tT),
    fields: ratio(fC, fT),
    arguments: ratio(aC, aT),
    inputFields: ratio(iC, iT),
    inputFieldsBothStates: ratio(bC, bT),
    enumValues: ratio(eC, eT),
    enumValuesObserved: ratio(oC, oT),
  };
}

/** Walk a runtime value against its input type, recording input-field presence, enum values and value classes. */
/** Add a test name to an element's sorted `tests` list. */
export function tagTest(el: { tests?: string[] }, test: string | undefined): void {
  if (!test) return;
  const tests = (el.tests ??= []);
  if (tests.includes(test)) return;
  tests.push(test);
  tests.sort();
}

export function walkInputValue(report: CoverageReport, type: GraphQLInputType, value: unknown, into?: ValueClasses, test?: string): void {
  if (isNonNullType(type)) type = (type as GraphQLNonNull<GraphQLInputType>).ofType;
  const list = isListType(type);
  // GraphQL input coercion: a single value for a list type is a list of one, and is classified as such.
  if (list && value != null && !Array.isArray(value)) value = [value];
  if (into) classifyValue(value, into);
  if (value === null || value === undefined) return;

  if (list) {
    const inner = (type as GraphQLList<GraphQLInputType>).ofType;
    for (const item of value as unknown[]) walkInputValue(report, inner, item, into, test);
    return;
  }
  if (isEnumType(type)) {
    // Values arrive as the client wrote them (variables as JSON, literals untyped), so an enum value is its name.
    const ec = report.enums[(type as GraphQLEnumType).name];
    const ev = typeof value === "string" ? ec?.values[value] : undefined;
    if (ev) {
      ev.hits++;
      tagTest(ev, test);
    }
    return;
  }
  if (isInputObjectType(type)) {
    const it = type as GraphQLInputObjectType;
    const ic = report.inputTypes[it.name];
    if (!ic || typeof value !== "object") return;
    ic.hits++;
    const obj = value as Record<string, unknown>;
    for (const field of Object.values(it.getFields())) {
      const fc = ic.fields[field.name];
      if (!fc) continue;
      if (Object.prototype.hasOwnProperty.call(obj, field.name) && obj[field.name] !== undefined) {
        fc.sent++;
        tagTest(fc, test);
        walkInputValue(report, field.type, obj[field.name], fc.values, test);
      } else {
        fc.omitted++;
      }
    }
    return;
  }
  // scalar: already classified above
}

export interface RecordResult {
  valid: boolean;
  errors: string[];
}

/** The first operation name in a document's text, for documents that do not parse. */
function operationNameOf(document: string): string | null {
  return /\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(document)?.[1] ?? null;
}

/** Record one captured operation into an existing report. */
export function recordOperation(report: CoverageReport, schema: GraphQLSchema, op: CapturedOperation): RecordResult {
  if (!op.document) {
    report.operations.unresolved = (report.operations.unresolved ?? 0) + 1;
    return { valid: false, errors: [op.persistedId ? `persisted document ${op.persistedId} not resolved: give its manifest` : "capture has no document"] };
  }
  const invalid = (errors: string[]): RecordResult => {
    report.operations.invalid++;
    addInvalid(report, { operationName: op.operationName ?? operationNameOf(op.document!), errors, count: 1, sources: op.source ? [op.source] : [] });
    return { valid: false, errors };
  };
  let doc;
  try {
    doc = parse(op.document);
  } catch (e) {
    return invalid([String((e as Error).message)]);
  }
  const errors = validate(schema, doc);
  if (errors.length > 0) return invalid(errors.map((e) => e.message));

  const variables = op.variables ?? {};
  const typeInfo = new TypeInfo(schema);

  const wanted = op.operationName ?? null;
  const operations = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION && (!wanted || d.name?.value === wanted));
  if (operations.length === 0) {
    // A server rejects this request, so none of it (fragments included) counts as covered.
    report.operations.invalid++;
    return { valid: false, errors: [`no operation named "${wanted}" in the document`] };
  }
  for (const def of operations) {
    report.operations.total++;
    report.operations[def.operation]++;
    const name = def.name?.value ?? "(anonymous)";
    report.operations.named[name] = (report.operations.named[name] ?? 0) + 1;
    if (op.source) (report.tests ??= {})[op.source] = (report.tests[op.source] ?? 0) + 1;
  }

  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      OperationDefinition(node) {
        if (wanted && node.name?.value !== wanted) return false;
        return undefined;
      },
      Field(node) {
        // The document passed validation, so every field resolves to a parent type and a definition.
        const parent = typeInfo.getParentType()!;
        const fieldDef = typeInfo.getFieldDef()!;
        const tc = report.types[parent.name];
        if (!tc) return;
        tc.hits++;
        const fc = tc.fields[fieldDef.name];
        if (!fc) return;
        fc.hits++;
        tagTest(fc, op.source);
        const returned = getNamedType(getNullableType(fieldDef.type));
        const rt = report.types[returned.name];
        if (rt) rt.hits++;
        for (const argNode of node.arguments!) {
          const ac = fc.args[argNode.name.value];
          if (!ac) continue; // excluded or deprecated argument
          const argDef = fieldDef.args.find((a) => a.name === argNode.name.value)!;
          // Untyped on purpose: typed coercion would add input-field defaults the client never sent and turn
          // enum names into internal values. Variables inside literals are substituted; missing ones become undefined.
          const value = valueFromASTUntyped(argNode.value, variables);
          if (value === undefined) continue; // variable not supplied: argument effectively absent
          ac.hits++;
          tagTest(ac, op.source);
          const vc = report.argumentValues[`${parent.name}.${fieldDef.name}(${argNode.name.value})`];
          walkInputValue(report, argDef.type, value, vc, op.source);
        }
      },
      FragmentDefinition(node) {
        const cond = report.types[node.typeCondition.name.value];
        if (cond) cond.hits++;
      },
    }),
  );
  for (const [en, values] of Object.entries(op.responseEnums ?? {})) {
    const ec = report.enums[en];
    if (!ec) continue;
    for (const v of new Set(values)) if (ec.values[v]) ec.values[v].observed++;
  }
  if (op.responseValues) report.operations.responses = (report.operations.responses ?? 0) + 1;
  for (const [path, outcomes] of Object.entries(op.responseValues ?? {})) {
    const dot = path.indexOf(".");
    const fc = report.types[path.slice(0, dot)]?.fields[path.slice(dot + 1)];
    if (!fc) continue;
    const returned = (fc.returned ??= { value: 0, null: 0, empty: 0 });
    for (const o of new Set(outcomes)) returned[o]++;
  }
  for (const [name, concrete] of Object.entries(op.responseTypes ?? {})) {
    const at = report.abstractTypes?.[name];
    if (!at) continue;
    at.seen++;
    for (const t of new Set(concrete)) if (at.possible[t] !== undefined) at.possible[t]++;
  }
  return { valid: true, errors: [] };
}

/**
 * The two response-based numbers, set on the summary only when some capture carried response data:
 * requested fields that came back with a value, and possible types of the interfaces and unions seen in responses.
 */
export function summariseResponses(report: CoverageReport): void {
  delete report.summary.fieldsReturned;
  delete report.summary.possibleTypes;
  if (!report.operations.responses) return;
  let fC = 0, fT = 0, pC = 0, pT = 0;
  for (const t of Object.values(report.types))
    for (const f of Object.values(t.fields)) {
      if (!f.returned) continue;
      fT++;
      if (f.returned.value > 0) fC++;
    }
  for (const at of Object.values(report.abstractTypes ?? {})) {
    if (!at.seen) continue;
    for (const n of Object.values(at.possible)) {
      pT++;
      if (n > 0) pC++;
    }
  }
  // Each number appears only when there is something to count: 0 of 0 would read as a perfect score.
  if (fT) report.summary.fieldsReturned = ratio(fC, fT);
  if (pT) report.summary.possibleTypes = ratio(pC, pT);
}

export interface ComputeOptions extends CoverageOptions {
  run?: RunInfo;
  /**
   * Subgraph SDLs by name, to attribute elements to subgraphs. Not needed for a composed supergraph:
   * its `@join__` directives are read automatically.
   */
  subgraphSdls?: Record<string, string>;
  /** Production field usage to join with the result. */
  usage?: UsageData;
  /** Persisted-operation manifests, to resolve captures that only carry a persisted id. */
  persisted?: PersistedManifest[];
}

/** Compute a full report from a schema and a list of captured operations. */
export function computeCoverage(
  schemaInput: string | object | GraphQLSchema,
  operations: Iterable<CapturedOperation>,
  options: ComputeOptions = {},
): CoverageReport {
  const schema = toSchema(schemaInput);
  const { run, subgraphSdls, usage, persisted, ...covOptions } = options;
  const report = emptyReport(schema, covOptions);
  if (run) report.run = run;
  for (const op of resolvePersisted([...operations], persisted)) recordOperation(report, schema, op);
  report.summary = summarise(report);
  summariseResponses(report);
  const membership = subgraphSdls && Object.keys(subgraphSdls).length ? subgraphsFromSdls(subgraphSdls) : subgraphsFromSupergraph(schema);
  if (membership) attributeSubgraphs(report, membership);
  if (usage) applyUsage(report, usage);
  return report;
}
