import { describe, expect, it } from "vitest";
import { buildSchema, parse } from "graphql";
import { collectResponseEnums } from "../src/index.js";

const schema = buildSchema(/* GraphQL */ `
  enum Status { OPEN CLOSED }
  enum Kind { A B }
  interface Node { id: ID! }
  type Court implements Node { id: ID!, status: Status!, kinds: [Kind] }
  type Club implements Node { id: ID!, status: Status }
  union Thing = Court | Club
  type Query { node: Node, things: [Thing!]!, court: Court }
`);

describe("collectResponseEnums", () => {
  it("follows aliases, lists, inline fragments with and without a type condition, and named fragments", () => {
    const doc = /* GraphQL */ `
      query Q {
        c: court { s: status kinds ... { id } }
        things { __typename ...ClubBits ... on Court { status } }
      }
      fragment ClubBits on Club { status }
    `;
    const data = { c: { s: "OPEN", kinds: ["A", null, "B"], id: "1" }, things: [{ __typename: "Club", status: "CLOSED" }, { __typename: "Court", status: "OPEN" }] };
    expect(collectResponseEnums(schema, parse(doc), data, "Q")).toEqual({ Status: ["CLOSED", "OPEN"], Kind: ["A", "B"] });
  });

  it("applies a concrete fragment only to objects of that type", () => {
    const doc = `{ things { __typename ... on Club { status } } }`;
    expect(collectResponseEnums(schema, doc, { things: [{ __typename: "Court", status: "OPEN" }] })).toEqual({});
  });

  it("skips fields missing from the data, unknown fragments and unknown type conditions", () => {
    const doc = `{ court { status kinds ...Missing ... on Ghost { status } } }`;
    expect(collectResponseEnums(schema, doc, { court: { kinds: ["A"], status: "OPEN" } })).toEqual({ Status: ["OPEN"], Kind: ["A"] });
    expect(collectResponseEnums(schema, `{ court { status } }`, { court: {} })).toEqual({});
    expect(collectResponseEnums(schema, `{ court { status } }`, { court: null })).toEqual({});
  });

  it("returns nothing when the operation or its root type is missing", () => {
    expect(collectResponseEnums(schema, `query A { court { status } }`, { court: { status: "OPEN" } }, "B")).toEqual({});
    expect(collectResponseEnums(schema, `mutation { x }`, { x: 1 })).toEqual({});
  });
});
