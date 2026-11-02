/** Bits of a response-shape entry: what a response path held, in at least one place, in one response. */
export const SHAPE_VALUE = 1;
export const SHAPE_NULL = 2;
export const SHAPE_ERROR = 4;
export const SHAPE_EMPTY = 8;

/**
 * Summarise a GraphQL response as "response path -> outcome bits" without a schema, for capture layers that only see
 * the wire (Playwright); the report resolves paths to schema fields through the operation. No data is kept. A path is the
 * response keys (aliases included) joined by dots, with list indexes dropped: `clubs.courts.status`.
 * A null at a path an error points to, or above one (null propagation), counts as an error, not a null, and so
 * does a path on the way to an error that propagation removed from the data altogether.
 * An empty list counts as empty, not as a value. Null items inside a list are left out unless an error points at them.
 */
export function collectResponseShape(data: unknown, errors?: readonly { path?: readonly (string | number)[] }[] | null): Record<string, number> {
  const shape: Record<string, number> = {};
  const mark = (path: string, bit: number) => (shape[path] = (shape[path] ?? 0) | bit);
  // Errors are matched on the exact path, list indexes included, so one item's error does not mark its siblings.
  const errorAt = new Set<string>();
  const errorOnTheWay = new Set<string>();
  for (const e of errors ?? []) {
    const path = e.path ?? [];
    if (!path.length) continue;
    for (let i = 1; i <= path.length; i++) {
      errorAt.add(path.slice(0, i).join("."));
      errorOnTheWay.add(path.slice(0, i).filter((k) => typeof k === "string").join("."));
    }
    mark(path.filter((k) => typeof k === "string").join("."), SHAPE_ERROR);
  }
  const walk = (value: unknown, prefix: string, exact: string): void => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, prefix, `${exact}.${i}`));
    if (value === null || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const at = exact ? `${exact}.${key}` : key;
      if (v === null) mark(path, errorAt.has(at) ? SHAPE_ERROR : SHAPE_NULL);
      else if (Array.isArray(v) && v.length === 0) mark(path, SHAPE_EMPTY);
      else {
        mark(path, SHAPE_VALUE);
        walk(v, path, at);
      }
    }
  };
  walk(data, "", "");
  // Null propagation can remove a whole branch: a path on the way to an error that never appears in the data failed too.
  for (const p of errorOnTheWay) if (p && !(p in shape)) mark(p, SHAPE_ERROR);
  return shape;
}
