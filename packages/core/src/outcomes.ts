import { Kind, type DocumentNode, type FieldNode, type FragmentDefinitionNode, type GraphQLSchema, type OperationDefinitionNode, type SelectionSetNode } from "graphql";
import { SHAPE_EMPTY, SHAPE_ERROR, SHAPE_NULL, SHAPE_VALUE } from "./shape.js";
import type { ResponseOutcome } from "./types.js";

interface Fields {
  getFields(): Record<string, { type: unknown }>;
}
const namedTypeName = (t: unknown): string => {
  let x = t as { name?: string; ofType?: unknown };
  while (x.ofType) x = x.ofType as typeof x;
  return x.name!;
};

const BITS: [number, ResponseOutcome][] = [[SHAPE_VALUE, "value"], [SHAPE_NULL, "null"], [SHAPE_EMPTY, "empty"], [SHAPE_ERROR, "error"]];

/**
 * Turn a schema-free response shape (wire capture) into per-field outcomes ("Type.field" -> outcomes), as the
 * server plugins record them, by resolving each response path through the operation's selections. Under
 * unions and interfaces, a response key selected on several type conditions credits each of them.
 */
export function shapeToValues(schema: GraphQLSchema, doc: DocumentNode, op: OperationDefinitionNode, shape: Record<string, number>): Record<string, ResponseOutcome[]> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);

  const fieldsFor = (set: SelectionSetNode, parent: string, key: string, out: { node: FieldNode; parent: string }[] = []) => {
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if ((sel.alias?.value ?? sel.name.value) === key) out.push({ node: sel, parent });
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        fieldsFor(sel.selectionSet, sel.typeCondition?.name.value ?? parent, key, out);
      } else {
        const frag = fragments.get(sel.name.value)!; // the document passed validation: every spread has its fragment
        fieldsFor(frag.selectionSet, frag.typeCondition.name.value, key, out);
      }
    }
    return out;
  };

  const resolve = (set: SelectionSetNode, parent: string, keys: string[]): string[] => {
    const [key, ...rest] = keys;
    const out: string[] = [];
    for (const { node, parent: on } of fieldsFor(set, parent, key)) {
      const def = (schema.getType(on) as unknown as Partial<Fields> | undefined)?.getFields?.()[node.name.value];
      if (!def) continue; // __typename
      if (!rest.length) out.push(`${on}.${node.name.value}`);
      else if (node.selectionSet) out.push(...resolve(node.selectionSet, namedTypeName(def.type), rest));
    }
    return out;
  };

  const bits = new Map<string, number>();
  const root = schema.getRootType(op.operation)!.name;
  for (const [path, b] of Object.entries(shape)) for (const coord of resolve(op.selectionSet, root, path.split("."))) bits.set(coord, (bits.get(coord) ?? 0) | b);
  return Object.fromEntries([...bits].map(([coord, b]) => [coord, BITS.filter(([bit]) => b & bit).map(([, o]) => o)]));
}
