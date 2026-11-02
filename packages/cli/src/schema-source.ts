import { getIntrospectionQuery, printSchema, lexicographicSortSchema } from "graphql";
import { readFileSync } from "node:fs";
import { toSchema } from "@gqlcov/core";
import type { GraphQLSchema } from "graphql";
import { fetchApolloSchema, fetchCosmoSchema } from "./registry.js";

export interface LoadedSchema {
  schema: GraphQLSchema;
  /** SDL text when the source was an SDL file; otherwise printed from the schema. */
  sdl: string;
  /** True when `pointer` is a local SDL file that coverage services can display as-is. */
  isSdlFile: boolean;
  /** Subgraph SDLs the registry provided (Cosmo). */
  subgraphSdls?: Record<string, string>;
  label: string;
}

/** Whether the pointer names a remote source: an endpoint or a registry reference. */
export const isRemotePointer = (pointer: string): boolean => /^(https?:\/\/|apollo:|cosmo:)/.test(pointer);

/**
 * Load a schema from a `.graphql` SDL file, an introspection `.json` file, an http(s) endpoint via introspection,
 * `apollo:graph@variant` (GraphOS, APOLLO_KEY) or `cosmo:[namespace/]graph` (Cosmo, COSMO_API_KEY).
 */
export async function loadSchema(pointer: string, headers: Record<string, string> = {}, clientVersion?: string): Promise<LoadedSchema> {
  if (pointer.startsWith("apollo:")) {
    const r = await fetchApolloSchema(pointer.slice("apollo:".length), { clientVersion });
    return { schema: toSchema(r.sdl), sdl: r.sdl, isSdlFile: false, label: r.label };
  }
  if (pointer.startsWith("cosmo:")) {
    const r = await fetchCosmoSchema(pointer.slice("cosmo:".length));
    return { schema: toSchema(r.sdl), sdl: r.sdl, isSdlFile: false, subgraphSdls: r.subgraphSdls, label: r.label };
  }
  if (/^https?:\/\//.test(pointer)) {
    const res = await fetch(pointer, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    if (!res.ok) throw new Error(`Introspection failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`Introspection errors: ${json.errors.map((e) => e.message).join("; ")}`);
    const schema = toSchema(json);
    return { schema, sdl: printSchema(lexicographicSortSchema(schema)), isSdlFile: false, label: pointer };
  }
  const text = readFileSync(pointer, "utf8");
  const schema = toSchema(text);
  const isSdlFile = !text.trim().startsWith("{");
  return { schema, sdl: isSdlFile ? text : printSchema(lexicographicSortSchema(schema)), isSdlFile, label: pointer };
}

/** @deprecated use loadSchema */
export async function loadSchemaFrom(pointer: string, headers: Record<string, string> = {}): Promise<GraphQLSchema> {
  return (await loadSchema(pointer, headers)).schema;
}
