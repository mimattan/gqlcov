import { describe, expect, it } from "vitest";
import { computeCoverage, mergeReports, parsePersistedManifest, resolvePersisted } from "../src/index.js";

const sdl = `type Query { a: Int, b: Int }`;

describe("persisted documents", () => {
  it("parses the Apollo manifest, the Relay map and a plain array", () => {
    const apollo = parsePersistedManifest({ format: "apollo-persisted-query-manifest", version: 1, operations: [{ id: "h1", body: "{ a }", name: "A", type: "query" }] });
    expect(apollo.get("h1")).toBe("{ a }");
    expect(parsePersistedManifest(`{"r1":"{ b }"}`).get("r1")).toBe("{ b }");
    expect(parsePersistedManifest([{ id: "x", query: "{ a b }" }]).get("x")).toBe("{ a b }");
  });

  it("resolves ids from manifests and from captures that carried both id and document", () => {
    const ops = resolvePersisted(
      [{ persistedId: "h1" }, { persistedId: "apq", document: "{ b }" }, { persistedId: "apq" }, { persistedId: "nope" }],
      [parsePersistedManifest({ h1: "{ a }" })],
    );
    expect(ops.map((o) => o.document)).toEqual(["{ a }", "{ b }", "{ b }", undefined]);
  });

  it("counts unresolved captures instead of failing, and merges the count", () => {
    const r = computeCoverage(sdl, [{ persistedId: "h1" }, { persistedId: "zz" }], { persisted: [parsePersistedManifest({ h1: "{ a }" })] });
    expect(r.operations).toMatchObject({ total: 1, invalid: 0, unresolved: 1 });
    expect(r.types.Query.fields.a.hits).toBe(1);
    const m = mergeReports([r, r]);
    expect(m.operations.unresolved).toBe(2);
    const plain = computeCoverage(sdl, [{ document: "{ b }" }]);
    expect(plain.operations.unresolved).toBeUndefined();
  });
});
