import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapturedOperation } from "./types.js";

export const DEFAULT_CAPTURE_DIR = ".gqlcov/captures";

let counter = 0;

/** Append one captured operation as a JSON file in `dir`. Safe to call from many processes: file names are unique per process. */
export function writeCapture(dir: string, op: CapturedOperation): string {
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${(counter++).toString(36)}.json`;
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...op }));
  return path;
}

/** Read every `*.json` capture from one or more directories. */
export function readCaptures(dirs: string | string[]): CapturedOperation[] {
  const out: CapturedOperation[] = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (Array.isArray(parsed)) out.push(...parsed);
        else out.push(parsed);
      } catch {
        // ignore unreadable files
      }
    }
  }
  return out;
}
