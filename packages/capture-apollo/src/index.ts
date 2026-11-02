import type { ApolloServerPlugin } from "@apollo/server";
import { collectResponse, DEFAULT_CAPTURE_DIR, writeCapture, type CapturedOperation } from "@gqlcov/core";
import { print, type DocumentNode } from "graphql";

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
 * with what its response contained: enum values, whether each field came back with a value, and concrete types.
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
            if (data) {
              const facts = collectResponse(ctx.schema, ctx.document, data, ctx.operationName);
              Object.assign(op, { responseEnums: facts.enums, responseValues: facts.values, responseTypes: facts.types });
            }
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

/** The execution arguments a WebSocket server hands to its operation hook (graphql-ws `onOperation`, for example). */
export interface SubscriptionArgs {
  document: DocumentNode;
  operationName?: string | null;
  variableValues?: Record<string, unknown> | null;
  contextValue?: unknown;
}

/**
 * Apollo Server's plugins never see subscriptions: they run on a separate WebSocket server. Call the returned
 * function from that server's operation hook to capture each subscription once, when the client subscribes:
 *
 *   const capture = gqlcovSubscriptionCapture();
 *   useServer({ schema, onOperation: (ctx, message, args) => capture(args) }, wsServer); // graphql-ws 5
 */
export function gqlcovSubscriptionCapture(options: CaptureOptions = {}): (args: SubscriptionArgs) => void {
  const dir = options.dir ?? process.env.GQLCOV_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
  return (args) => {
    if (!isEnabled(options.enabled)) return;
    try {
      writeCapture(dir, {
        document: print(args.document),
        operationName: args.operationName ?? null,
        variables: args.variableValues ?? null,
        source: options.source?.((args.contextValue as Record<string, unknown> | undefined) ?? {}),
      });
    } catch {
      // never break a subscription because of coverage capture
    }
  };
}
