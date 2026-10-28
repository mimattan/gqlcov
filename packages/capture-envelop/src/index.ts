import type { Plugin } from "@envelop/core";
import { collectResponseEnums, DEFAULT_CAPTURE_DIR, writeCapture, type CapturedOperation } from "@gqlcov/core";
import { print, type DocumentNode, type GraphQLSchema } from "graphql";

export interface CaptureOptions {
  /** Folder to write captures to. Default `.gqlcov/captures`. */
  dir?: string;
  /** Only capture when this returns true. Default: capture when `GQLCOV_CAPTURE` is set or NODE_ENV is "test". */
  enabled?: boolean | (() => boolean);
  /** Attach a source label to each capture, e.g. read from a request header set by the test runner. */
  source?: (context: Record<string, unknown>) => string | undefined;
}

function isEnabled(opt: CaptureOptions["enabled"]): boolean {
  if (typeof opt === "function") return opt();
  if (typeof opt === "boolean") return opt;
  return Boolean(process.env.GQLCOV_CAPTURE) || process.env.NODE_ENV === "test";
}

/**
 * Captures every executed operation (document, operation name, variables, enum values in the response)
 * into one JSON file each. Works with any Envelop-based server, including GraphQL Yoga.
 */
export function useGqlcovCapture(options: CaptureOptions = {}): Plugin {
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  return {
    onExecute({ args }) {
      if (!isEnabled(options.enabled)) return;
      const op: CapturedOperation = {
        document: print(args.document as DocumentNode),
        operationName: args.operationName ?? null,
        variables: (args.variableValues as Record<string, unknown> | null) ?? null,
        source: options.source?.((args.contextValue as Record<string, unknown>) ?? {}),
      };
      return {
        onExecuteDone({ result }) {
          try {
            // Streamed (incremental) results are captured without response enums.
            const data = "data" in result ? result.data : undefined;
            if (data) op.responseEnums = collectResponseEnums(args.schema as GraphQLSchema, args.document as DocumentNode, data, args.operationName);
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
