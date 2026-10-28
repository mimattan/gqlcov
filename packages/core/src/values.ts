import type { ValueClasses } from "./types.js";

export function emptyValueClasses(): ValueClasses {
  return { null: 0, empty: 0, zero: 0, negative: 0, positive: 0, typical: 0, listOne: 0, listMany: 0 };
}

/** Classify one leaf or list value into the ValueClasses buckets. Lists are classified by length only. */
export function classifyValue(value: unknown, into: ValueClasses): void {
  if (value === null || value === undefined) {
    into.null++;
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) into.empty++;
    else if (value.length === 1) into.listOne++;
    else into.listMany++;
    return;
  }
  if (typeof value === "string") {
    if (value.length === 0) into.empty++;
    else into.typical++;
    return;
  }
  if (typeof value === "number") {
    if (value === 0) into.zero++;
    else if (value < 0) into.negative++;
    else into.positive++;
    return;
  }
  into.typical++;
}

export function addValueClasses(a: ValueClasses, b: ValueClasses): ValueClasses {
  const out = emptyValueClasses();
  for (const k of Object.keys(out) as (keyof ValueClasses)[]) out[k] = a[k] + b[k];
  return out;
}
