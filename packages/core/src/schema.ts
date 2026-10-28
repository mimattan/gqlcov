import { buildASTSchema, buildClientSchema, buildSchema, GraphQLSchema, lexicographicSortSchema, parse, printSchema, type IntrospectionQuery } from "graphql";
import { createHash } from "node:crypto";

/** Accepts SDL text, an introspection result (`{ data: { __schema } }` or `{ __schema }`), or a GraphQLSchema. */
export function toSchema(input: string | object | GraphQLSchema): GraphQLSchema {
  if (input instanceof GraphQLSchema) return input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) return toSchema(JSON.parse(trimmed) as object);
    return buildSchema(trimmed);
  }
  const obj = input as Record<string, unknown>;
  const data = (obj.data as Record<string, unknown> | undefined) ?? obj;
  if (data.__schema) return buildClientSchema(data as unknown as IntrospectionQuery);
  if (obj.kind === "Document") return buildASTSchema(obj as never);
  throw new Error("Unrecognised schema input: expected SDL, introspection JSON or a GraphQLSchema");
}

export function schemaHash(schema: GraphQLSchema): string {
  const sdl = printSchema(lexicographicSortSchema(schema));
  return createHash("sha256").update(sdl).digest("hex").slice(0, 16);
}

export { parse };
