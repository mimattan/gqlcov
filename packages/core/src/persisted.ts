import type { CapturedOperation } from "./types.js";

/** Persisted document id to document text. */
export type PersistedManifest = Map<string, string>;

/**
 * Read a persisted-operation manifest into an id -> document map. Accepts the Apollo persisted query manifest
 * (`{ format: "apollo-persisted-query-manifest", operations: [{ id, body }] }`), the Relay persisted output
 * (`{ "<id>": "<document>" }`), and any array of `{ id, body | query | document }`.
 */
export function parsePersistedManifest(text: string | object): PersistedManifest {
  const obj = (typeof text === "string" ? JSON.parse(text) : text) as unknown;
  const out: PersistedManifest = new Map();
  const addEntry = (e: unknown) => {
    if (!e || typeof e !== "object") return;
    const r = e as Record<string, unknown>;
    const id = r.id ?? r.hash ?? r.sha256Hash;
    const body = r.body ?? r.query ?? r.document;
    if (typeof id === "string" && typeof body === "string") out.set(id, body);
  };
  if (Array.isArray(obj)) obj.forEach(addEntry);
  else if (obj && typeof obj === "object") {
    const r = obj as Record<string, unknown>;
    if (Array.isArray(r.operations)) r.operations.forEach(addEntry);
    else for (const [id, body] of Object.entries(r)) if (typeof body === "string") out.set(id, body);
  }
  return out;
}

/** Merge several manifests; later ones win on the same id. */
export function mergePersistedManifests(manifests: PersistedManifest[]): PersistedManifest {
  const out: PersistedManifest = new Map();
  for (const m of manifests) for (const [k, v] of m) out.set(k, v);
  return out;
}

/**
 * Fill in the document of captures that only carry a persisted id. Documents come from the manifests given
 * and from other captures in the same run that carried both the id and the document (automatic persisted
 * queries send both on a cache miss). Captures that stay unresolved are returned as they are.
 */
export function resolvePersisted(ops: CapturedOperation[], manifests: PersistedManifest[] = []): CapturedOperation[] {
  const known = mergePersistedManifests(manifests);
  for (const op of ops) if (op.persistedId && op.document) known.set(op.persistedId, op.document);
  if (known.size === 0) return ops;
  return ops.map((op) => (!op.document && op.persistedId && known.has(op.persistedId) ? { ...op, document: known.get(op.persistedId)! } : op));
}
