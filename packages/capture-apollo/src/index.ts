import type { ApolloServerPlugin } from "@apollo/server";
import { collectResponseEnums, DEFAULT_CAPTURE_DIR, writeCapture, type CapturedOperation } from "@gqlcov/core";
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

/**
 * Apollo Server 4/5 plugin: captures every operation that resolved (parsed and validated) into the capture folder,
 * with the enum values its response contained.
 */
export function gqlcovCapturePlugin<TContext extends Record<string, unknown> = Record<string, unknown>>(
  options: CaptureOptions = {},
): ApolloServerPlugin<TContext> {
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  return {
    async requestDidStart() {
      if (!isEnabled(options.enabled)) return {};
      let op: CapturedOperation | undefined;
      return {
        async didResolveOperation(ctx) {
          op = {
            document: print(ctx.document),
            operationName: ctx.operationName ?? null,
            variables: (ctx.request.variables as Record<string, unknown> | undefined) ?? null,
            source: options.source?.(ctx.contextValue),
          };
        },
        async willSendResponse(ctx) {
          if (!op || !ctx.document) return;
          try {
            // For incremental (deferred) responses only the initial payload is walked.
            const body = ctx.response.body;
            const data = body.kind === "single" ? body.singleResult.data : body.initialResult.data;
            if (data) op.responseEnums = collectResponseEnums(ctx.schema, ctx.document, data, ctx.operationName);
          } catch {
            // response walking is best effort
          }
          try {
            writeCapture(dir, op);
          } catch {
            // never break the request because of coverage capture
          }
        },
      };
    },
  };
}
