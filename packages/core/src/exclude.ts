import type { CoverageOptions } from "./types.js";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^.()]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export class Excluder {
  private readonly patterns: RegExp[];
  readonly excludeDeprecated: boolean;

  constructor(options: CoverageOptions = {}) {
    this.excludeDeprecated = options.excludeDeprecated ?? true;
    this.patterns = (options.exclude ?? []).map(globToRegExp);
  }

  /** Introspection types (`__Type` etc.) are always excluded. */
  isExcluded(path: string, deprecated = false): boolean {
    if (path.startsWith("__")) return true;
    if (deprecated && this.excludeDeprecated) return true;
    return this.patterns.some((p) => p.test(path));
  }
}
