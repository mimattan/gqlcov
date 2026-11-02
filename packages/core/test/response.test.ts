import { describe, expect, it } from "vitest";
import { buildSchema, parse } from "graphql";
import { collectResponse, collectResponseEnums } from "../src/index.js";

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

describe("collectResponse", () => {
  it("records field outcomes and the concrete types behind interfaces and unions", () => {
    const doc = `{ node { __typename id } things { __typename ... on Court { kinds } ... on Club { status } } court { status kinds } }`;
    const data = {
      node: { __typename: "Club", id: "1" },
      things: [{ __typename: "Court", kinds: [] }, { __typename: "Club", status: null }, { __typename: "Court", kinds: ["A"] }],
      court: null,
    };
    const facts = collectResponse(schema, doc, data);
    expect(facts.values).toEqual({
      "Query.node": ["value"],
      "Node.id": ["value"],
      "Query.things": ["value"],
      "Court.kinds": ["empty", "value"],
      "Club.status": ["null"],
      "Query.court": ["null"],
    });
    expect(facts.types).toEqual({ Node: ["Club"], Thing: ["Club", "Court"] });
    expect(facts.enums).toEqual({ Kind: ["A"] });
  });

  it("learns no concrete types when __typename was not selected", () => {
    expect(collectResponse(schema, `{ node { id } }`, { node: { id: "1" } }).types).toEqual({});
    expect(collectResponse(schema, `{ node { __typename } }`, { node: null })).toMatchObject({ types: {}, values: { "Query.node": ["null"] } });
  });

  it("returns empty facts when the operation is missing", () => {
    expect(collectResponse(schema, `query A { court { id } }`, {}, "B")).toEqual({ enums: {}, values: {}, types: {} });
  });
});
