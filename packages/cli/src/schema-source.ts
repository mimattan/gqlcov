import { getIntrospectionQuery } from "graphql";
import { readFileSync } from "node:fs";
import { toSchema } from "@gqlcov/core";
import type { GraphQLSchema } from "graphql";

/** Load a schema from a `.graphql` SDL file, an introspection `.json` file, or an http(s) endpoint via introspection. */
export async function loadSchemaFrom(pointer: string, headers: Record<string, string> = {}): Promise<GraphQLSchema> {
  if (/^https?:\/\//.test(pointer)) {
    const res = await fetch(pointer, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    if (!res.ok) throw new Error(`Introspection failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`Introspection errors: ${json.errors.map((e) => e.message).join("; ")}`);
    return toSchema(json);
  }
  return toSchema(readFileSync(pointer, "utf8"));
}
