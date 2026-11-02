import { Kind, parse, type DocumentNode, type FragmentDefinitionNode, type GraphQLSchema, type SelectionSetNode } from "graphql";
import type { ResponseOutcome } from "./types.js";

/**
 * The parts of a schema type the walker reads. The schema comes from the server, which may have loaded another
 * copy of `graphql` (CJS next to ESM is common), so graphql's own `isObjectType`-style predicates would throw
 * "from another module or realm". Types are read by shape instead.
 */
interface AnyType {
  name: string;
  ofType?: AnyType;
  getFields?: () => Record<string, { type: AnyType }>;
  getValues?: () => unknown;
}

const named = (t: AnyType): AnyType => (t.ofType ? named(t.ofType) : t);
const isEnum = (t: AnyType) => typeof t.getValues === "function";
/** Object types carry `isTypeOf` (possibly undefined); interfaces and unions carry `resolveType` instead. */
const isConcrete = (t: AnyType) => "isTypeOf" in t;
const isAbstract = (t: AnyType) => "resolveType" in t;

/** What a response showed about the schema; only names and outcomes, never the data itself. */
export interface ResponseFacts {
  /** Enum values returned, by enum name. */
  enums: Record<string, string[]>;
  /** Per selected field ("ParentType.field"), whether it came back with a value, as null, or as an empty list. */
  values: Record<string, ResponseOutcome[]>;
  /** Per interface or union, the concrete types returned, read from `__typename` where the operation selected it. */
  types: Record<string, string[]>;
}

/**
 * Walk a response alongside its operation's selection set, so aliases, fragments and lists are followed,
 * and record which enum values, field outcomes and concrete types it contained.
 */
export function collectResponse(schema: GraphQLSchema, document: DocumentNode | string, data: unknown, operationName?: string | null): ResponseFacts {
  const doc = typeof document === "string" ? parse(document) : document;
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments[d.name.value] = d;
  const op = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION && (!operationName || d.name?.value === operationName));
  const empty: ResponseFacts = { enums: {}, values: {}, types: {} };
  if (!op || op.kind !== Kind.OPERATION_DEFINITION) return empty;
  const root = schema.getRootType(op.operation) as unknown as AnyType | undefined;
  if (!root) return empty;
  const sets = { enums: new Map<string, Set<string>>(), values: new Map<string, Set<ResponseOutcome>>(), types: new Map<string, Set<string>>() };
  const add = <T>(map: Map<string, Set<T>>, key: string, value: T) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  };
  const recordEnum = (enumName: string, value: unknown) => {
    if (Array.isArray(value)) return value.forEach((v) => recordEnum(enumName, v));
    if (typeof value === "string") add(sets.enums, enumName, value);
  };
  const recordTypes = (abstractName: string, value: unknown) => {
    if (Array.isArray(value)) return value.forEach((v) => recordTypes(abstractName, v));
    const typename = value !== null && typeof value === "object" ? (value as { __typename?: unknown }).__typename : undefined;
    if (typeof typename === "string") add(sets.types, abstractName, typename);
  };

  const walk = (selectionSet: SelectionSetNode, parent: AnyType, value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((v) => walk(selectionSet, parent, v));
    const obj = value as Record<string, unknown>;
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        const def = parent.getFields?.()[sel.name.value]; // unions have no fields; __typename has no definition
        const key = sel.alias?.value ?? sel.name.value;
        if (!def || !(key in obj)) continue;
        const v = obj[key];
        add(sets.values, `${parent.name}.${sel.name.value}`, v === null ? "null" : Array.isArray(v) && v.length === 0 ? "empty" : "value");
        const type = named(def.type);
        if (isEnum(type)) recordEnum(type.name, v);
        else if (sel.selectionSet) {
          if (isAbstract(type)) recordTypes(type.name, v);
          walk(sel.selectionSet, type, v);
        }
      } else {
        const frag = sel.kind === Kind.FRAGMENT_SPREAD ? fragments[sel.name.value] : sel;
        if (!frag) continue;
        const cond = frag.typeCondition ? (schema.getType(frag.typeCondition.name.value) as unknown as AnyType | undefined) : parent;
        if (!cond) continue;
        // A concrete type condition that does not match the object's __typename does not apply.
        if (isConcrete(cond) && typeof obj.__typename === "string" && obj.__typename !== cond.name) continue;
        walk(frag.selectionSet, cond, obj);
      }
    }
  };

  walk(op.selectionSet, root, data);
  const out = <T extends string>(map: Map<string, Set<T>>) => Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort()]));
  return { enums: out(sets.enums), values: out(sets.values), types: out(sets.types) };
}

/** Enum values present in a response, by enum name. */
export function collectResponseEnums(schema: GraphQLSchema, document: DocumentNode | string, data: unknown, operationName?: string | null): Record<string, string[]> {
  return collectResponse(schema, document, data, operationName).enums;
}
