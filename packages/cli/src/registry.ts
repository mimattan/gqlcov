import type { UsageData } from "@gqlcov/core";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export interface RegistrySchema {
  sdl: string;
  /** Where it came from, for messages. */
  label: string;
  /** One SDL per subgraph when the registry can provide them (Cosmo), for per-subgraph attribution. */
  subgraphSdls?: Record<string, string>;
}

const env = (name: string, hint: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: ${hint}`);
  return v;
};

async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url}: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const j = json as { message?: string; errors?: { message: string }[] };
    throw new Error(`${url}: ${res.status} ${res.statusText}${j.message ? `: ${j.message}` : j.errors ? `: ${j.errors.map((e) => e.message).join("; ")}` : ""}`);
  }
  return json;
}

// ---------------------------------------------------------------------------------------------------------------
// Apollo GraphOS (Platform API, the same endpoint and queries rover uses)

export interface ApolloOptions {
  apiKey?: string;
  /** Default https://api.apollographql.com/api/graphql, or APOLLO_REGISTRY_URL. */
  url?: string;
  fetchImpl?: FetchLike;
  clientVersion?: string;
}

/** "graph@variant" or "graph" (variant "current"). */
export function parseGraphRef(ref: string): { graph: string; variant: string } {
  const at = ref.indexOf("@");
  if (!ref || ref.startsWith("@") || ref.endsWith("@")) throw new Error(`Expected graph@variant, got "${ref}"`);
  return at < 0 ? { graph: ref, variant: "current" } : { graph: ref.slice(0, at), variant: ref.slice(at + 1) };
}

async function apolloQuery(o: ApolloOptions, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = o.apiKey ?? env("APOLLO_KEY", "a graph API key (service:...) or personal key (user:...) from GraphOS Studio");
  const url = o.url ?? process.env.APOLLO_REGISTRY_URL ?? "https://api.apollographql.com/api/graphql";
  const json = (await postJson(o.fetchImpl ?? (fetch as unknown as FetchLike), url, {
    "x-api-key": key,
    "apollographql-client-name": "gqlcov",
    "apollographql-client-version": o.clientVersion ?? "0",
  }, { query, variables })) as { data?: Record<string, unknown>; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`GraphOS: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("GraphOS: empty response");
  return json.data;
}

const SUPERGRAPH_QUERY = `query GqlcovSupergraphFetch($graph_id: ID!, $variant: String!) {
  graph(id: $graph_id) {
    variants { name }
    variant(name: $variant) {
      latestApprovedLaunch { build { result { __typename
        ... on BuildFailure { errorMessages { message code } }
        ... on BuildSuccess { coreSchema { coreDocument } } } } }
      latestPublication { schema { document } }
    }
  }
}`;

/**
 * The supergraph SDL of a variant (with its @join__ directives), or for a monograph the latest published schema.
 */
export async function fetchApolloSchema(ref: string, o: ApolloOptions = {}): Promise<RegistrySchema> {
  const { graph, variant } = parseGraphRef(ref);
  const data = (await apolloQuery(o, SUPERGRAPH_QUERY, { graph_id: graph, variant })) as {
    graph: null | {
      variants: { name: string }[];
      variant: null | {
        latestApprovedLaunch: null | { build: null | { result: null | { __typename: string; errorMessages?: { message: string }[]; coreSchema?: { coreDocument: string } } } };
        latestPublication: null | { schema: null | { document: string } };
      };
    };
  };
  if (!data.graph) throw new Error(`GraphOS: no graph "${graph}" visible to this key`);
  const v = data.graph.variant;
  if (!v) throw new Error(`GraphOS: graph "${graph}" has no variant "${variant}" (variants: ${data.graph.variants.map((x) => x.name).join(", ") || "none"})`);
  const result = v.latestApprovedLaunch?.build?.result;
  if (result?.__typename === "BuildSuccess" && result.coreSchema?.coreDocument) return { sdl: result.coreSchema.coreDocument, label: `GraphOS supergraph ${graph}@${variant}` };
  if (result?.__typename === "BuildFailure") throw new Error(`GraphOS: the latest launch of ${graph}@${variant} failed to compose: ${result.errorMessages?.map((e) => e.message).join("; ")}`);
  const doc = v.latestPublication?.schema?.document;
  if (doc) return { sdl: doc, label: `GraphOS schema ${graph}@${variant}` };
  throw new Error(`GraphOS: ${graph}@${variant} has no composed supergraph and no published schema`);
}

const USAGE_QUERY = `query GqlcovFieldUsage($graph_id: ID!, $variant: String!, $since: Timestamp!, $limit: Int!) {
  graph(id: $graph_id) {
    variant(name: $variant) {
      schemaCoordinateInsightsUsageReport(
        since: $since, limit: $limit, groupByClient: false,
        filters: { coordinateKinds: [OBJECT_FIELD] },
        orderBy: { column: REFERENCING_OPERATION_COUNT, direction: DESCENDING }
      ) { records { namedType namedAttribute referencingOperationCount estimatedExecutionCount used } }
    }
  }
}`;

export interface ApolloUsageOptions extends ApolloOptions {
  /** Platform API Timestamp: ISO 8601, or seconds relative to now as a string ("-2592000"). Default 30 days ago. */
  since?: string;
  /** "requests" (operations that referenced the field, the Insights "Requests" column) or "executions" (estimated resolver executions). Default requests. */
  metric?: "requests" | "executions";
  /** Maximum rows. Default 20000. */
  limit?: number;
}

/** Production usage per output field of a variant, from GraphOS Insights. */
export async function fetchApolloUsage(ref: string, o: ApolloUsageOptions = {}): Promise<UsageData> {
  const { graph, variant } = parseGraphRef(ref);
  const since = o.since ?? "-2592000";
  const data = (await apolloQuery(o, USAGE_QUERY, { graph_id: graph, variant, since, limit: o.limit ?? 20000 })) as {
    graph: null | { variant: null | { schemaCoordinateInsightsUsageReport: { records: { namedType: string; namedAttribute: string; referencingOperationCount: number | string; estimatedExecutionCount: number | string; used: boolean }[] } } };
  };
  const records = data.graph?.variant?.schemaCoordinateInsightsUsageReport.records;
  if (!records) throw new Error(`GraphOS: no usage report for ${graph}@${variant} (does the key see this graph?)`);
  const fields: Record<string, number> = {};
  for (const r of records) fields[`${r.namedType}.${r.namedAttribute}`] = Number(o.metric === "executions" ? r.estimatedExecutionCount : r.referencingOperationCount);
  const now = new Date();
  const from = /^-?\d+$/.test(since) ? new Date(now.getTime() + Number(since) * 1000).toISOString() : since;
  return { source: `apollo ${graph}@${variant} (${o.metric === "executions" ? "estimated executions" : "requests"})`, from, to: now.toISOString(), fields };
}

// ---------------------------------------------------------------------------------------------------------------
// WunderGraph Cosmo (Platform API over Connect, the same RPCs wgc uses)

export interface CosmoOptions {
  apiKey?: string;
  /** Default https://cosmo-cp.wundergraph.com, or COSMO_API_URL. */
  url?: string;
  fetchImpl?: FetchLike;
}

/** "namespace/graph" or "graph" (namespace "default"). */
export function parseCosmoRef(ref: string): { namespace: string; name: string } {
  const slash = ref.indexOf("/");
  if (!ref || ref.startsWith("/") || ref.endsWith("/")) throw new Error(`Expected [namespace/]graph, got "${ref}"`);
  return slash < 0 ? { namespace: "default", name: ref } : { namespace: ref.slice(0, slash), name: ref.slice(slash + 1) };
}

async function cosmoRpc(o: CosmoOptions, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = o.apiKey ?? env("COSMO_API_KEY", "an API key from Cosmo Studio");
  const base = (o.url ?? process.env.COSMO_API_URL ?? "https://cosmo-cp.wundergraph.com").replace(/\/$/, "");
  const json = (await postJson(o.fetchImpl ?? (fetch as unknown as FetchLike), `${base}/wg.cosmo.platform.v1.PlatformService/${method}`, {
    authorization: `Bearer ${key}`,
    "connect-protocol-version": "1",
    "user-agent": "gqlcov",
  }, body)) as { response?: { code?: string; details?: string } } & Record<string, unknown>;
  if (json.response?.code && json.response.code !== "OK") throw new Error(`Cosmo ${method}: ${json.response.code}${json.response.details ? `: ${json.response.details}` : ""}`);
  return json;
}

/**
 * The router schema of a federated graph plus one SDL per subgraph from the latest composition, so that
 * coverage is attributed per subgraph (Cosmo's composed schema carries no @join__ directives).
 */
export async function fetchCosmoSchema(ref: string, o: CosmoOptions = {}): Promise<RegistrySchema> {
  const { namespace, name } = parseCosmoRef(ref);
  const g = (await cosmoRpc(o, "GetFederatedGraphSDLByName", { name, namespace })) as { sdl?: string };
  if (!g.sdl) throw new Error(`Cosmo: federated graph ${namespace}/${name} has no composed schema`);
  const subgraphSdls: Record<string, string> = {};
  try {
    const info = (await cosmoRpc(o, "GetFederatedGraphByName", { name, namespace, includeMetrics: false })) as { subgraphs?: { name: string }[] };
    for (const s of info.subgraphs ?? []) {
      const r = (await cosmoRpc(o, "GetSubgraphSDLFromLatestComposition", { name: s.name, fedGraphName: name, namespace })) as { sdl?: string };
      if (r.sdl) subgraphSdls[s.name] = r.sdl;
    }
  } catch (e) {
    console.error(`gqlcov: could not fetch subgraph SDLs, coverage will not be split per subgraph: ${(e as Error).message}`);
  }
  return { sdl: g.sdl, label: `Cosmo federated graph ${namespace}/${name}`, subgraphSdls: Object.keys(subgraphSdls).length ? subgraphSdls : undefined };
}

export interface CosmoUsageOptions extends CosmoOptions {
  /** Window in hours, counted back from now. Default 720 (30 days). Ignored when from/to are given. */
  range?: number;
  from?: string;
  to?: string;
}

/** Production usage per output field of a federated graph, from Cosmo analytics. */
export async function fetchCosmoUsage(ref: string, o: CosmoUsageOptions = {}): Promise<UsageData> {
  const { namespace, name } = parseCosmoRef(ref);
  const body: Record<string, unknown> = { federatedGraphName: name, namespace };
  if (o.from && o.to) body.dateRange = { start: o.from, end: o.to };
  else body.range = o.range ?? 720;
  const r = (await cosmoRpc(o, "GetGraphFieldUsage", body)) as {
    fields?: { typeName: string; fieldName: string; requestCount: number | string }[];
    dateRange?: { start: string; end: string };
  };
  const fields: Record<string, number> = {};
  for (const f of r.fields ?? []) fields[`${f.typeName}.${f.fieldName}`] = (fields[`${f.typeName}.${f.fieldName}`] ?? 0) + Number(f.requestCount);
  const to = r.dateRange?.end ?? o.to ?? new Date().toISOString();
  const from = r.dateRange?.start ?? o.from ?? new Date(new Date(to).getTime() - (o.range ?? 720) * 3600 * 1000).toISOString();
  return { source: `cosmo ${namespace}/${name} (requests)`, from, to, fields };
}
