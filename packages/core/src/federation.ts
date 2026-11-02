/** Federation machinery that is never part of the API surface: `join__*`, `link__*`, `_Any`, `_Service`, `Query._entities`. */
export function isFederationInternal(path: string): boolean {
  return /^(join|link|core|federation)__/.test(path) || /^_(Any|Entity|Service|FieldSet)$/.test(path) || path === "Query._entities" || path === "Query._service";
}
