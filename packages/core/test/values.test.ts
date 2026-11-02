import { describe, expect, it } from "vitest";
import { addValueClasses, classifyValue, emptyValueClasses } from "../src/index.js";

describe("value classes", () => {
  it("classifies nulls, strings, numbers, lists and everything else", () => {
    const v = emptyValueClasses();
    for (const x of [null, undefined, "", "abc", 0, -2, 3.5, [], [1], [1, 2], true, { a: 1 }]) classifyValue(x, v);
    expect(v).toEqual({ null: 2, empty: 2, zero: 1, negative: 1, positive: 1, typical: 3, listOne: 1, listMany: 1 });
  });

  it("adds two sets of classes", () => {
    const a = { ...emptyValueClasses(), null: 1, listMany: 2 };
    const b = { ...emptyValueClasses(), null: 3, zero: 1 };
    expect(addValueClasses(a, b)).toEqual({ ...emptyValueClasses(), null: 4, zero: 1, listMany: 2 });
  });
});
