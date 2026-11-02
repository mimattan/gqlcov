import { describe, expect, it } from "vitest";
import { buildSchema, getIntrospectionQuery, graphqlSync, parse } from "graphql";
import { schemaHash, toSchema } from "../src/index.js";

const sdl = `type Query { a: Int, b(x: String): String }`;
const schema = buildSchema(sdl);
const introspection = graphqlSync({ schema, source: getIntrospectionQuery() });

describe("toSchema", () => {
  it("accepts SDL, introspection in every wrapping, a DocumentNode and a schema, all hashing the same", () => {
    const hash = schemaHash(schema);
    const inputs = [sdl, JSON.stringify(introspection), introspection, introspection.data!, parse(sdl), schema];
    for (const input of inputs) expect(schemaHash(toSchema(input as never))).toBe(hash);
    expect(toSchema(schema)).toBe(schema);
  });

  it("rejects anything else", () => {
    expect(() => toSchema({ hello: "world" })).toThrow("Unrecognised schema input");
  });
});
