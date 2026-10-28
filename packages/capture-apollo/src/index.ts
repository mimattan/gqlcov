import type { ApolloServerPlugin } from "@apollo/server";
import { DEFAULT_CAPTURE_DIR, writeCapture } from "@gqlcov/core";
import { print } from "graphql";

export interface CaptureOptions {
  dir?: string;
  enabled?: boolean | (() => boolean);
  source?: (context: Record<string, unknown>) => string | undefined;
}

function isEnabled(opt: CaptureOptions["enabled"]): boolean {
  if (typeof opt === "function") return opt();
  if (typeof opt === "boolean") return opt;
  return Boolean(process.env.GQLCOV_CAPTURE) || process.env.NODE_ENV === "test";
}

/** Apollo Server 4 plugin: captures every operation that resolved (parsed and validated) into the capture folder. */
export function gqlcovCapturePlugin<TContext extends Record<string, unknown> = Record<string, unknown>>(
  options: CaptureOptions = {},
): ApolloServerPlugin<TContext> {
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  return {
    async requestDidStart() {
      if (!isEnabled(options.enabled)) return {};
      return {
        async didResolveOperation(ctx) {
          try {
            writeCapture(dir, {
              document: print(ctx.document),
              operationName: ctx.operationName ?? null,
              variables: (ctx.request.variables as Record<string, unknown> | undefined) ?? null,
              source: options.source?.(ctx.contextValue),
            });
          } catch {
            // never break the request because of coverage capture
          }
        },
      };
    },
  };
}
