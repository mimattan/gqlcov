/** One operation as executed by the server (or seen on the wire) during a test run. */
export interface CapturedOperation {
  /** The GraphQL document, printed. Absent when the client sent only a persisted id that the capture layer could not resolve. */
  document?: string;
  /** Persisted document id as sent by the client (APQ sha256Hash, a persisted query list id, Relay doc_id, documentId). */
  persistedId?: string;
  operationName?: string | null;
  variables?: Record<string, unknown> | null;
  /** ISO timestamp of execution. */
  timestamp?: string;
  /** Free-form origin, e.g. the test file name when the capture layer knows it. */
  source?: string;
  /** Enum values that appeared in the response data, by enum name. Server-side capture fills this; wire capture does not. */
  responseEnums?: Record<string, string[]>;
}

export interface RunInfo {
  id?: string;
  sha?: string;
  branch?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Which parts of the schema to leave out of totals. */
export interface CoverageOptions {
  /** Skip deprecated fields, arguments, input fields and enum values. Default true. */
  excludeDeprecated?: boolean;
  /** Glob-like patterns matched against "Type", "Type.field", "Type.field(arg)" or "Input.field". `*` matches within a segment. */
  exclude?: string[];
}

export interface ArgCoverage {
  hits: number;
  deprecated: boolean;
  /** Tests (capture `source` labels) that passed this argument, sorted. Absent when no capture carried a source. */
  tests?: string[];
}

export interface FieldCoverage {
  hits: number;
  deprecated: boolean;
  args: Record<string, ArgCoverage>;
  /** Subgraphs that resolve this field; set by `attributeSubgraphs`. */
  graphs?: string[];
  /** Production requests that selected this field in the usage window; set by `applyUsage`. */
  requests?: number;
  /** Tests (capture `source` labels) that requested this field, sorted. */
  tests?: string[];
}

export interface TypeCoverage {
  kind: "OBJECT" | "INTERFACE";
  hits: number;
  fields: Record<string, FieldCoverage>;
  /** Subgraphs that define this type; set by `attributeSubgraphs`. */
  graphs?: string[];
}

/** Value classes observed for a scalar, enum or list position. */
export interface ValueClasses {
  /** Explicit null sent. */
  null: number;
  /** String: "" ; List: [] */
  empty: number;
  /** Numbers: 0 */
  zero: number;
  negative: number;
  positive: number;
  /** Non-empty string, true/false, object, ID */
  typical: number;
  /** Lists only */
  listOne: number;
  listMany: number;
}

export interface InputFieldCoverage {
  /** Field present in the sent value (any value, including null). */
  sent: number;
  /** Input object sent without this field. */
  omitted: number;
  deprecated: boolean;
  required: boolean;
  values: ValueClasses;
  graphs?: string[];
  /** Tests that sent this field, sorted. */
  tests?: string[];
}

export interface InputTypeCoverage {
  /** Number of times a value of this input type was sent. */
  hits: number;
  fields: Record<string, InputFieldCoverage>;
  graphs?: string[];
}

export interface EnumValueCoverage {
  /** Times the value was sent as input (argument or input field). */
  hits: number;
  /** Operations whose response contained the value. */
  observed: number;
  deprecated: boolean;
  graphs?: string[];
  /** Tests that sent this value, sorted. */
  tests?: string[];
}

export interface EnumCoverage {
  /** Reachable as input through an included argument or input field; only these count toward `enumValues`. */
  input: boolean;
  /** Returned by an included output field; only these count toward `enumValuesObserved`. */
  output: boolean;
  values: Record<string, EnumValueCoverage>;
  graphs?: string[];
}

export interface Ratio {
  covered: number;
  total: number;
  /** 0..100, two decimals; 100 when total is 0. */
  percent: number;
}

export interface CoverageSummary {
  types: Ratio;
  fields: Ratio;
  arguments: Ratio;
  inputFields: Ratio;
  /** Input fields seen both sent and omitted (optional fields only). */
  inputFieldsBothStates: Ratio;
  /** Values of input-reachable enums sent at least once. */
  enumValues: Ratio;
  /** Values of output enums seen in at least one response. Reported, never gated. */
  enumValuesObserved: Ratio;
}

/** Summary keys that are informational only: excluded from the no-decrease gate. */
export const UNGATED_SUMMARY_KEYS: readonly (keyof CoverageSummary)[] = ["enumValuesObserved"];

export interface OperationStats {
  total: number;
  query: number;
  mutation: number;
  subscription: number;
  /** Named operations and how often each ran. */
  named: Record<string, number>;
  /** Documents that failed to parse or validate against the schema. */
  invalid: number;
  /** Captures that carried only a persisted id no manifest or other capture could resolve. Absent in older reports. */
  unresolved?: number;
}

export interface CoverageReport {
  version: 1;
  generatedAt: string;
  schemaHash: string;
  run?: RunInfo;
  options: Required<CoverageOptions>;
  operations: OperationStats;
  summary: CoverageSummary;
  types: Record<string, TypeCoverage>;
  inputTypes: Record<string, InputTypeCoverage>;
  enums: Record<string, EnumCoverage>;
  /** Value classes for top-level arguments, keyed "Type.field(arg)". */
  argumentValues: Record<string, ValueClasses>;
  /** One summary per subgraph, present when the schema was a supergraph or subgraph SDLs were given. */
  subgraphs?: Record<string, CoverageSummary>;
  /** Join with production field usage, present when usage data was given. */
  usage?: UsageJoin;
  /** Operations per test (capture `source` label). Absent when no capture carried a source. */
  tests?: Record<string, number>;
}

/** What one test covered, from the `tests` lists on each element. Paths as in `uncovered`. */
export interface TestCoverage {
  name: string;
  operations: number;
  fields: string[];
  arguments: string[];
  inputFields: string[];
  enumValues: string[];
  /** Elements no other test covers: removing this test loses them. */
  unique: string[];
}

/** Production field usage, as `gqlcov usage apollo|cosmo` write it or hand-made: requests per "Type.field". */
export interface UsageData {
  /** Where the numbers came from, e.g. "apollo my-graph@current". */
  source?: string;
  /** ISO timestamps of the window. */
  from?: string;
  to?: string;
  fields: Record<string, number>;
}

export interface UsageJoin {
  source?: string;
  from?: string;
  to?: string;
  /** Output fields with production traffic: how many of them a test requested. */
  usedFields: Ratio;
  /** Used in production, never tested: the risk list, most requested first. */
  untestedUsed: { path: string; requests: number }[];
  /** Tested but no production traffic in the window. */
  testedUnused: string[];
  /** Neither: deprecation candidates. */
  unusedUntested: string[];
  /** Usage paths that are not in the (included) schema: removed fields still being called, or excluded ones. */
  unknown: string[];
}

export interface CoverageDiff {
  base: { summary: CoverageSummary; generatedAt: string; subgraphs?: Record<string, CoverageSummary> };
  head: { summary: CoverageSummary; generatedAt: string; subgraphs?: Record<string, CoverageSummary> };
  delta: Record<keyof CoverageSummary, number>;
  newlyCovered: string[];
  lostCoverage: string[];
  /** Fields in head's schema that base did not have, and vice versa. */
  schemaAdded: string[];
  schemaRemoved: string[];
  /** Per-subgraph deltas, for subgraphs present in both reports. */
  subgraphs?: Record<string, Record<keyof CoverageSummary, number>>;
}

export interface GateOptions {
  /** Minimum field coverage percent. */
  minFields?: number;
  minInputFields?: number;
  minEnumValues?: number;
  /** Fail if any summary percent drops versus this report. */
  base?: CoverageReport;
  /** Tolerance in percentage points for the no-decrease check. Default 0. */
  tolerance?: number;
  /** Apply the thresholds and the no-decrease check to these subgraphs instead of the whole schema. "*" means every subgraph in the report. */
  subgraphs?: string[];
  /** Minimum percent of fields with production traffic that are tested. Needs usage data in the report. */
  minUsedFields?: number;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
}
