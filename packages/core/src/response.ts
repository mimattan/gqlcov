import { Kind, parse, type DocumentNode, type FragmentDefinitionNode, type GraphQLSchema, type SelectionSetNode } from "graphql";

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

/**
 * Enum values present in a response, by enum name. Walks the selection set alongside the data, so aliases,
 * fragments and lists are followed; only the value names are kept, never the response itself.
 */
export function collectResponseEnums(
  schema: GraphQLSchema,
  document: DocumentNode | string,
  data: unknown,
  operationName?: string | null,
): Record<string, string[]> {
  const doc = typeof document === "string" ? parse(document) : document;
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments[d.name.value] = d;
  const op = doc.definitions.find(
    (d) => d.kind === Kind.OPERATION_DEFINITION && (!operationName || d.name?.value === operationName),
  );
  if (!op || op.kind !== Kind.OPERATION_DEFINITION) return {};
  const root = schema.getRootType(op.operation) as unknown as AnyType | undefined;
  if (!root) return {};
  const found = new Map<string, Set<string>>();

  const record = (enumName: string, value: unknown) => {
    if (Array.isArray(value)) return value.forEach((v) => record(enumName, v));
    if (typeof value !== "string") return;
    let set = found.get(enumName);
    if (!set) found.set(enumName, (set = new Set()));
    set.add(value);
  };

  const walk = (selectionSet: SelectionSetNode, parent: AnyType, value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((v) => walk(selectionSet, parent, v));
    const obj = value as Record<string, unknown>;
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        const def = parent.getFields?.()[sel.name.value]; // unions have no fields; only __typename is selectable there
        const key = sel.alias?.value ?? sel.name.value;
        if (!def || !(key in obj)) continue;
        const type = named(def.type);
        if (isEnum(type)) record(type.name, obj[key]);
        else if (sel.selectionSet) walk(sel.selectionSet, type, obj[key]);
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
  return Object.fromEntries([...found].map(([k, v]) => [k, [...v].sort()]));
}
