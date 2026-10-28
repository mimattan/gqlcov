import {
  getNamedType,
  getNullableType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  parse,
  TypeInfo,
  validate,
  valueFromAST,
  visit,
  visitWithTypeInfo,
  type GraphQLInputType,
  type OperationDefinitionNode,
} from "graphql";
import { Excluder } from "./exclude.js";
import { schemaHash, toSchema } from "./schema.js";
import type {
  CapturedOperation,
  CoverageOptions,
  CoverageReport,
  CoverageSummary,
  EnumCoverage,
  InputTypeCoverage,
  Ratio,
  RunInfo,
  TypeCoverage,
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
    const type = schema.getType(tn);
    if (!isObjectType(type) && !isInterfaceType(type)) continue;
    const defs = type.getFields();
    for (const [fn, fc] of Object.entries(tc.fields)) {
      const def = defs[fn];
      if (!def) continue;
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

export function summarise(r: Pick<CoverageReport, "types" | "inputTypes" | "enums">): CoverageSummary {
  let tC = 0, tT = 0, fC = 0, fT = 0, aC = 0, aT = 0, iC = 0, iT = 0, bC = 0, bT = 0, eC = 0, eT = 0, oC = 0, oT = 0;
  for (const t of Object.values(r.types)) {
    tT++;
    if (t.hits > 0) tC++;
    for (const f of Object.values(t.fields)) {
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
      if (input) {
        eT++;
        if (v.hits > 0) eC++;
      }
      if (e.output) {
        oT++;
        if ((v.observed ?? 0) > 0) oC++;
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
export function walkInputValue(report: CoverageReport, type: GraphQLInputType, value: unknown, into?: ValueClasses): void {
  if (isNonNullType(type)) type = (type as GraphQLNonNull<GraphQLInputType>).ofType;
  if (into) classifyValue(value, into);
  if (value === null || value === undefined) return;

  if (isListType(type)) {
    const inner = (type as GraphQLList<GraphQLInputType>).ofType;
    const items = Array.isArray(value) ? value : [value]; // GraphQL input coercion: single value becomes a list of one
    for (const item of items) walkInputValue(report, inner, item, into);
    return;
  }
  if (isEnumType(type)) {
    const ec = report.enums[(type as GraphQLEnumType).name];
    const name = typeof value === "string" ? value : String(value);
    if (ec?.values[name]) ec.values[name].hits++;
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
        walkInputValue(report, field.type, obj[field.name], fc.values);
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

/** Record one captured operation into an existing report. */
export function recordOperation(report: CoverageReport, schema: GraphQLSchema, op: CapturedOperation): RecordResult {
  let doc;
  try {
    doc = parse(op.document);
  } catch (e) {
    report.operations.invalid++;
    return { valid: false, errors: [String((e as Error).message)] };
  }
  const errors = validate(schema, doc);
  if (errors.length > 0) {
    report.operations.invalid++;
    return { valid: false, errors: errors.map((e) => e.message) };
  }

  const variables = op.variables ?? {};
  const typeInfo = new TypeInfo(schema);

  const wanted = op.operationName ?? null;
  const operations = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  for (const def of operations) {
    if (wanted && def.name?.value !== wanted) continue;
    report.operations.total++;
    report.operations[def.operation]++;
    const name = def.name?.value ?? "(anonymous)";
    report.operations.named[name] = (report.operations.named[name] ?? 0) + 1;
  }

  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      OperationDefinition(node) {
        if (wanted && node.name?.value !== wanted) return false;
        return undefined;
      },
      Field(node) {
        const parent = typeInfo.getParentType();
        const fieldDef = typeInfo.getFieldDef();
        if (!parent || !fieldDef) return;
        const tc = report.types[parent.name];
        if (!tc) return;
        tc.hits++;
        const fc = tc.fields[fieldDef.name];
        if (!fc) return;
        fc.hits++;
        const returned = getNamedType(getNullableType(fieldDef.type));
        const rt = report.types[returned.name];
        if (rt) rt.hits++;
        for (const argNode of node.arguments ?? []) {
          const argDef = fieldDef.args.find((a) => a.name === argNode.name.value);
          const ac = fc.args[argNode.name.value];
          if (!argDef || !ac) continue;
          let value: unknown;
          if (argNode.value.kind === Kind.VARIABLE) {
            value = variables[argNode.value.name.value];
          } else {
            value = valueFromAST(argNode.value, argDef.type, variables);
          }
          if (value === undefined) continue; // variable not supplied: argument effectively absent
          ac.hits++;
          const vc = report.argumentValues[`${parent.name}.${fieldDef.name}(${argNode.name.value})`];
          walkInputValue(report, argDef.type, value, vc);
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
  return { valid: true, errors: [] };
}

export interface ComputeOptions extends CoverageOptions {
  run?: RunInfo;
}

/** Compute a full report from a schema and a list of captured operations. */
export function computeCoverage(
  schemaInput: string | object | GraphQLSchema,
  operations: Iterable<CapturedOperation>,
  options: ComputeOptions = {},
): CoverageReport {
  const schema = toSchema(schemaInput);
  const { run, ...covOptions } = options;
  const report = emptyReport(schema, covOptions);
  if (run) report.run = run;
  for (const op of operations) recordOperation(report, schema, op);
  report.summary = summarise(report);
  return report;
}
