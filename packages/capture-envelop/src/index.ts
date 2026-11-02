import type { Plugin } from "@envelop/core";
import { collectResponse, DEFAULT_CAPTURE_DIR, writeCapture, type CapturedOperation } from "@gqlcov/core";
import { print, type DocumentNode, type GraphQLSchema } from "graphql";

export interface CaptureOptions {
  /** Folder to write captures to. Default `.gqlcov/captures`. */
  dir?: string;
  /** Only capture when this returns true. Default: capture when `GQLCOV_CAPTURE` is set or NODE_ENV is "test". */
  enabled?: boolean | (() => boolean);
  /** Attach a source label to each capture, e.g. read from a request header set by the test runner. */
  source?: (context: Record<string, unknown>) => string | undefined;
  /** Who sent the operation, e.g. the role of the authenticated user, so coverage can be split per identity. */
  identity?: (context: Record<string, unknown>) => string | undefined;
}

function isEnabled(opt: CaptureOptions["enabled"]): boolean {
  if (typeof opt === "function") return opt();
  if (typeof opt === "boolean") return opt;
  return Boolean(process.env.GQLCOV_CAPTURE) || process.env.NODE_ENV === "test";
}

interface Args {
  document: unknown;
  operationName?: string | null;
  variableValues?: unknown;
  contextValue?: unknown;
}

function save(dir: string, op: CapturedOperation): void {
  try {
    writeCapture(dir, op);
  } catch {
    // never break the request because of coverage capture
  }
}

/**
 * Captures every executed operation (document, operation name, variables, and what the response contained:
 * enum values, field outcomes and concrete types)
 * into one JSON file each. Works with any Envelop-based server, including GraphQL Yoga. Subscriptions are
 * captured once, when the client subscribes, without response data.
 */
export function useGqlcovCapture(options: CaptureOptions = {}): Plugin {
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  const base = (args: Args): CapturedOperation => ({
    document: print(args.document as DocumentNode),
    operationName: args.operationName ?? null,
    variables: (args.variableValues as Record<string, unknown> | null) ?? null,
    source: options.source?.((args.contextValue as Record<string, unknown>) ?? {}),
    identity: options.identity?.((args.contextValue as Record<string, unknown>) ?? {}),
  });
  return {
    onSubscribe({ args }) {
      if (isEnabled(options.enabled)) save(dir, base(args));
    },
    onExecute({ args }) {
      if (!isEnabled(options.enabled)) return;
      const op = base(args);
      return {
        onExecuteDone({ result }) {
          try {
            // Streamed (incremental) results are captured without response facts.
            const single = "data" in result || "errors" in result ? result : undefined;
            // A response whose data is null still says which fields failed, through its errors.
            if (single && (single.data || single.errors?.length)) {
              const facts = collectResponse(args.schema as GraphQLSchema, args.document as DocumentNode, single.data, args.operationName, single.errors);
              Object.assign(op, { responseEnums: facts.enums, responseValues: facts.values, responseTypes: facts.types });
            }
          } catch {
            // response walking is best effort
          }
          save(dir, op);
        },
      };
    },
  };
}
