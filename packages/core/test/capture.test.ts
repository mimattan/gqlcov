import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptures, writeCapture } from "../src/index.js";

describe("capture files", () => {
  it("writes one file per operation and reads them back with a timestamp", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "gqlcov-")), "nested", "captures");
    const a = writeCapture(dir, { document: "{ a }", source: "t1" });
    const b = writeCapture(dir, { document: "{ b }" });
    expect(a).not.toBe(b);
    expect(readdirSync(dir)).toHaveLength(2);
    const ops = readCaptures(dir);
    expect(ops.map((o) => o.document).sort()).toEqual(["{ a }", "{ b }"]);
    expect(ops.find((o) => o.document === "{ a }")).toMatchObject({ source: "t1", timestamp: expect.any(String) });
  });

  it("reads arrays and several folders, and skips missing folders, other files and broken JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "gqlcov-"));
    const one = join(root, "one");
    const two = join(root, "two");
    mkdirSync(one);
    mkdirSync(two);
    writeFileSync(join(one, "batch.json"), JSON.stringify([{ document: "{ a }" }, { document: "{ b }" }]));
    writeFileSync(join(one, "notes.txt"), "not a capture");
    writeFileSync(join(one, "broken.json"), "{ nope");
    writeFileSync(join(two, "single.json"), JSON.stringify({ document: "{ c }" }));
    const ops = readCaptures([one, two, join(root, "missing")]);
    expect(ops.map((o) => o.document)).toEqual(["{ a }", "{ b }", "{ c }"]);
    expect(readCaptures(join(root, "missing"))).toEqual([]);
  });
});
