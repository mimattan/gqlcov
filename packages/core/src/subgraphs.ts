import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  Kind,
  parse,
  type ConstDirectiveNode,
  type DefinitionNode,
  type GraphQLSchema,
} from "graphql";
import { summarise } from "./coverage.js";
import { isFederationInternal } from "./federation.js";
import type { CoverageReport } from "./types.js";

/**
 * Which subgraph owns each schema element. Keys are "Type", "Type.field", "Input.field" and "Enum.VALUE";
 * a shared (value) type or field lists every subgraph that defines it.
 */
export interface SubgraphMembership {
  /** Subgraph names, sorted. */
  names: string[];
  elements: Map<string, string[]>;
}

const argString = (d: ConstDirectiveNode, name: string): string | undefined => {
  const a = d.arguments?.find((x) => x.name.value === name);
  return a && (a.value.kind === Kind.STRING || a.value.kind === Kind.ENUM) ? a.value.value : undefined;
};
const argBool = (d: ConstDirectiveNode, name: string): boolean | undefined => {
  const a = d.arguments?.find((x) => x.name.value === name);
  return a && a.value.kind === Kind.BOOLEAN ? a.value.value : undefined;
};

/**
 * Read ownership from a composed supergraph: `@join__graph` names the subgraphs, `@join__type` puts a type in a
 * subgraph, `@join__field` narrows a field (or input field) to some of the type's subgraphs, `@join__enumValue`
 * does the same for enum values. A field with no `@join__field` lives in every subgraph of its type.
 * Returns undefined when the schema is not a supergraph (no `join__Graph` enum).
 */
export function subgraphsFromSupergraph(schema: GraphQLSchema): SubgraphMembership | undefined {
  const graphEnum = schema.getType("join__Graph");
  if (!graphEnum || !isEnumType(graphEnum)) return undefined;
  const nameOf = new Map<string, string>();
  for (const v of graphEnum.getValues()) {
    const d = v.astNode?.directives?.find((x) => x.name.value === "join__graph");
    nameOf.set(v.name, (d && argString(d, "name")) ?? v.name);
  }
  const elements = new Map<string, string[]>();
  const graphsOf = (directives: readonly ConstDirectiveNode[] | undefined, directive: string): string[] | undefined => {
    const out: string[] = [];
    let seen = false;
    for (const d of directives ?? []) {
      if (d.name.value !== directive) continue;
      seen = true;
      if (argBool(d, "external")) continue;
      const g = argString(d, "graph");
      if (g) out.push(nameOf.get(g) ?? g);
    }
    return seen ? out : undefined;
  };
  const dedupe = (xs: string[]) => [...new Set(xs)].sort();

  for (const type of Object.values(schema.getTypeMap())) {
    if (isFederationInternal(type.name) || type.name.startsWith("__")) continue;
    const nodes = [type.astNode, ...type.extensionASTNodes].filter(Boolean);
    const typeGraphs = dedupe(nodes.flatMap((n) => graphsOf(n!.directives, "join__type") ?? []));
    if (typeGraphs.length === 0) continue;
    elements.set(type.name, typeGraphs);
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        const own = graphsOf(field.astNode?.directives, "join__field");
        const graphs = own === undefined ? typeGraphs : own.length ? dedupe(own) : typeGraphs;
        elements.set(`${type.name}.${field.name}`, graphs);
      }
    } else if (isEnumType(type)) {
      for (const v of type.getValues()) {
        const own = graphsOf(v.astNode?.directives, "join__enumValue");
        elements.set(`${type.name}.${v.name}`, own && own.length ? dedupe(own) : typeGraphs);
      }
    }
  }
  return { names: dedupe([...nameOf.values()]), elements };
}

/**
 * Read ownership from one SDL per subgraph (as `rover subgraph fetch` or `wgc subgraph fetch` print them).
 * Only parsed, never built, so federation directives need no definitions. `@external` fields are not owned.
 */
export function subgraphsFromSdls(sdls: Record<string, string>): SubgraphMembership {
  const elements = new Map<string, string[]>();
  const add = (path: string, graph: string) => {
    const cur = elements.get(path) ?? [];
    if (!cur.includes(graph)) elements.set(path, [...cur, graph].sort());
  };
  // Parsed SDL always carries directive, field and value arrays, even when empty.
  const isExternal = (directives: readonly ConstDirectiveNode[]) => directives.some((d) => d.name.value === "external" || d.name.value === "federation__external");

  for (const [graph, sdl] of Object.entries(sdls)) {
    const doc = parse(sdl, { noLocation: true });
    for (const def of doc.definitions as DefinitionNode[]) {
      if (!("name" in def) || !def.name) continue;
      const tn = def.name.value;
      if (isFederationInternal(tn)) continue;
      switch (def.kind) {
        case Kind.OBJECT_TYPE_DEFINITION:
        case Kind.OBJECT_TYPE_EXTENSION:
        case Kind.INTERFACE_TYPE_DEFINITION:
        case Kind.INTERFACE_TYPE_EXTENSION:
        case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        case Kind.INPUT_OBJECT_TYPE_EXTENSION:
          add(tn, graph);
          for (const f of def.fields!) {
            const path = `${tn}.${f.name.value}`;
            if (isFederationInternal(path) || isExternal(f.directives!)) continue;
            add(path, graph);
          }
          break;
        case Kind.ENUM_TYPE_DEFINITION:
        case Kind.ENUM_TYPE_EXTENSION:
          add(tn, graph);
          for (const v of def.values!) add(`${tn}.${v.name.value}`, graph);
          break;
        default:
          break;
      }
    }
  }
  return { names: Object.keys(sdls).sort(), elements };
}

/**
 * Tag every element of the report with the subgraphs that own it and add one summary per subgraph.
 * Elements the membership does not mention stay untagged and count only in the overall summary.
 */
export function attributeSubgraphs(report: CoverageReport, membership: SubgraphMembership): CoverageReport {
  const g = (path: string) => membership.elements.get(path);
  for (const [tn, t] of Object.entries(report.types)) {
    t.graphs = g(tn);
    for (const [fn, f] of Object.entries(t.fields)) f.graphs = g(`${tn}.${fn}`) ?? t.graphs;
  }
  for (const [tn, t] of Object.entries(report.inputTypes)) {
    t.graphs = g(tn);
    for (const [fn, f] of Object.entries(t.fields)) f.graphs = g(`${tn}.${fn}`) ?? t.graphs;
  }
  for (const [en, e] of Object.entries(report.enums)) {
    e.graphs = g(en);
    for (const [vn, v] of Object.entries(e.values)) v.graphs = g(`${en}.${vn}`) ?? e.graphs;
  }
  report.subgraphs = summariseSubgraphs(report, membership.names);
  return report;
}

/** One summary per subgraph, counting only the elements tagged with it. */
export function summariseSubgraphs(report: CoverageReport, names: string[] = Object.keys(report.subgraphs ?? {})): Record<string, CoverageReport["summary"]> {
  return Object.fromEntries(names.map((n) => [n, summarise(report, n)]));
}
