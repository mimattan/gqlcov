# gqlcov

Schema coverage for GraphQL APIs, measured from what your E2E tests actually executed.

gqlcov records every operation the server runs during a test run and compares it with the schema. It reports, per run:

- **Output coverage**: types, fields and arguments that were ever requested.
- **Input coverage**: for every field of every input type, whether it was ever *sent*, ever *omitted*, and ever sent as *null*. This is the part no other tool does.
- **Value classes**: which enum values were seen; per scalar whether empty, zero, negative and positive values were seen; per list whether empty, one and many were seen.
- **Operations**: how many queries, mutations and subscriptions ran, by name.
- **Responses** (server-side capture): which requested fields ever came back with a value, and which implementations of each interface or union came back.
- **Tests**: which test covered what, from a label on each capture.

Then it gates CI: fail below a minimum, or on any decrease versus the base branch.

It is server-agnostic (capture via an Envelop/Yoga plugin, an Apollo Server plugin, or a Playwright request hook with no server change) and runner-agnostic (anything that sends GraphQL over HTTP).

Full combinatorial coverage of input fields is deliberately **not** a metric here. See [Why not combinations](#why-not-combinations).

## Packages

| Package | What |
| --- | --- |
| `@gqlcov/core` | Coverage engine, merge, diff, gate, capture file I/O. Only depends on `graphql`. |
| `@gqlcov/cli` | `gqlcov report`, `merge`, `diff`, `gate`. JSON and HTML output. |
| `@gqlcov/capture-envelop` | Plugin for Envelop and GraphQL Yoga. |
| `@gqlcov/capture-apollo` | Plugin for Apollo Server 4/5. |
| `@gqlcov/capture-playwright` | Records GraphQL requests from the browser under test. No server change. |

## Quick start

1. Capture. Pick one:

   ```ts
   // GraphQL Yoga / Envelop
   import { useGqlcovCapture } from "@gqlcov/capture-envelop";
   createYoga({ schema, plugins: [useGqlcovCapture()] });

   // Apollo Server
   import { gqlcovCapturePlugin } from "@gqlcov/capture-apollo";
   new ApolloServer({ schema, plugins: [gqlcovCapturePlugin()] });

   // Playwright, no server change
   import { captureGraphQL } from "@gqlcov/capture-playwright";
   test.beforeEach(async ({ page }, testInfo) => {
     await captureGraphQL(page, { endpoint: "/graphql", source: testInfo.title });
   });
   ```

   Server plugins capture only when `GQLCOV_CAPTURE=1` or `NODE_ENV=test` (override with `enabled`). Captures land in `.gqlcov/captures/`, one small JSON file per operation.

   The packages are ESM. A CommonJS server loads them through `require(esm)`, which needs Node 22.12 or later.

2. Run your E2E suite with `GQLCOV_CAPTURE=1`.

3. Report and gate:

   ```sh
   gqlcov report --schema schema.graphql --html .gqlcov/report.html --untested
   gqlcov gate .gqlcov/report.json --min-fields 60 --base main-report.json
   ```

   `--schema` accepts an SDL file, an introspection JSON file, an `http(s)://` endpoint (add `-H "Authorization: Bearer ..."`), or a schema registry: `apollo:graph@variant` (GraphOS, `APOLLO_KEY`) and `cosmo:namespace/graph` (Cosmo, `COSMO_API_KEY`).

Console output looks like:

```
gqlcov: 5 operations (3 queries, 2 mutations, 0 subscriptions), schema 9c5b5e1aee01e655
  Types                                 100%  (6/6)
  Output fields                       71.43%  (15/21)
  Arguments                           42.86%  (3/7)
  Input-type fields sent                 70%  (7/10)
  Optional inputs sent and omitted    28.57%  (2/7)
  Nullable inputs sent as null           25%  (2/8)
  Enum values                         42.86%  (3/7)
```

## Did the data come back?

A field counts as covered once a test requests it, even if every response had it as `null`. All three capture layers also record what each response contained, so the report adds two informational numbers (never gated):

- **Fields that returned a value**: of the requested fields, how many came back non-null and non-empty at least once. A field that was always `null` or an empty list gets an "always null" or "always empty" badge in the HTML report and is listed by `--untested`: the test asks for it but never sees data, so a resolver that broke would go unnoticed.
- **Possible types returned**: for each interface or union your tests got back, which of its implementations or members came back, read from `__typename` where the operation selected it (Apollo Client and most clients add it). The HTML report lists them per interface and union.

**Errors** count too: GraphQL answers HTTP 200 and puts failures in an `errors` array that tests rarely read. A null that an error points at, or one above it from null propagation, counts as an error rather than a null, and so does a field on an error's path that propagation removed from the data. Such fields get an "error in n" badge in the HTML report and are listed under "returned an error" by `--untested` and in the Markdown summary; in JSON, `returned.error` counts the operations.

Only names and outcomes are kept, never response data. The Playwright capture has no schema, so it records only which response paths held a value, a null, an empty list or an error, and the report maps them to schema fields through the operation (under unions and interfaces, a key selected on several types credits each). It therefore writes captures when a request finishes, or fails (without response data); `captureGraphQL(page, { responses: false })` writes them as soon as requests are sent, as before. Both numbers appear only when some capture carried response data; possible types need `__typename` and come from the server plugins.

## Which test covers what

Give each capture a `source` label (the test name) and every field, argument, input field and enum value in the report lists the tests that hit it:

```ts
captureGraphQL(page, { source: testInfo.titlePath.join(" > ") });                    // Playwright
useGqlcovCapture({ source: (ctx) => ctx.request.headers.get("x-test-name") });       // Yoga / Envelop, header set by the test
```

```sh
gqlcov tests .gqlcov/report.json                       # per test: operations, fields, args, inputs, enum values, and what only it covers
gqlcov tests .gqlcov/report.json --test "create match" # everything one test touches
```

```
  Test                    Ops  Fields   Args  Inputs  Enums   Only
  create match              1       6      1       5      1      8
  list all                  1       3      0       0      0      0

  1 of 5 tests cover nothing the others do not ("Only" is 0).
```

In the HTML report each row shows its covering tests, typing a test name in the filter shows everything that test touches, and a Tests section lists what only each test covers. In the JSON, elements carry `tests` and `report.tests` counts operations per test.

## Subscriptions

Subscriptions are captured once, when the client subscribes (events are not counted, and no response data is read from them).

- **Envelop / Yoga**: `useGqlcovCapture()` captures them with no extra setup.
- **Apollo Server**: subscriptions run on a separate WebSocket server that Apollo's plugins never see. Call the capture from that server's operation hook:

  ```ts
  import { gqlcovSubscriptionCapture } from "@gqlcov/capture-apollo";
  const capture = gqlcovSubscriptionCapture();                 // same options as the plugin
  useServer({ schema, onOperation: (ctx, message, args) => capture(args) }, wsServer);   // graphql-ws 5
  ```

  Any WebSocket server works: pass the execution args (`document`, `operationName`, `variableValues`, `contextValue`).
- **Playwright**: `captureGraphQL` also reads WebSocket frames on sockets whose URL matches `endpoint`, for both `graphql-ws` (`subscribe`) and the older `subscriptions-transport-ws` (`start`). Given a browser context, it watches every page in it. Sockets mocked with `page.routeWebSocket` never reach the network, so Playwright does not report them and they are not captured.

## Persisted queries

Clients on Apollo persisted query lists, automatic persisted queries, Relay persisted documents or Cosmo persisted operations send an id instead of the document. The server plugins are unaffected; the Playwright capture records the id and resolves it in one of three ways:

- At capture time, from a manifest: `captureGraphQL(page, { manifest: "persisted-query-manifest.json" })`. Apollo's manifest, Relay's `{ id: text }` output and any `[{ id, body }]` array are accepted.
- Automatically for APQ: a cache miss sends both hash and document, and the hash is reused for later hash-only requests in the same run, as well as across captures at report time.
- At report time: `gqlcov report --persisted persisted-query-manifest.json`.

Captures that stay unresolved are counted as `unresolved` and listed in the console, never silently dropped.

## Schema registries: Apollo GraphOS and WunderGraph Cosmo

No schema file to check in: point `--schema` at the registry.

```sh
export APOLLO_KEY=service:...        # graph or personal key
gqlcov report -s apollo:my-graph@current

export COSMO_API_KEY=...
gqlcov report -s cosmo:default/my-graph
```

`apollo:` fetches the variant's latest composed supergraph (with its `@join__` directives, so coverage is split per subgraph) and falls back to the latest published schema for a monograph. `cosmo:` fetches the router schema and the SDL of every subgraph from the latest composition, and attributes coverage per subgraph from those. `APOLLO_REGISTRY_URL` and `COSMO_API_URL` override the endpoints. LCOV and Istanbul output refer to the SDL written to `--schema-out`.

## Production usage: test what is actually called

Both registries know which fields production traffic uses, and GraphOS also knows which input fields and enum values clients send. Join that with coverage and the question "what should we test next" has a ranked answer:

```sh
gqlcov usage apollo my-graph@current --since -2592000 -o .gqlcov/usage.json    # GraphOS Insights, last 30 days
gqlcov usage cosmo default/my-graph --range 720 -o .gqlcov/usage.json           # Cosmo analytics, last 30 days
gqlcov report -s apollo:my-graph@current --usage .gqlcov/usage.json --html .gqlcov/report.html
gqlcov gate .gqlcov/report.json --min-used-fields 95 --min-used-inputs 80
```

The report then lists, with request counts:

- **Used in production, never tested**: the risk list, most requested first: output fields no test requested, and input fields and enum values no test sent. `--min-used-fields` gates on the share of output fields with traffic that a test requested, `--min-used-inputs` on the share of input fields and enum values with traffic that a test sent.
- **Tested, no production traffic**: tests that protect nothing yet, or traffic that moved.
- **No traffic and no test**: deprecation candidates.
- **In usage data but not in the schema**: removed fields still being called.

The usage file is plain JSON keyed by schema coordinate, `{ "fields": { "Type.field": n, "Input.field": n, "Enum.VALUE": n } }`, so any other analytics source can produce it. Inputs are joined only when the file mentions at least one; Cosmo's bulk field usage covers output fields only. Values of output-only enums are not joined, since no test can send them. Apollo's `--metric executions` uses estimated resolver executions for output fields instead of referencing operations.

## Federation: coverage per subgraph

Give gqlcov the composed supergraph and every number is also reported per subgraph, so the team that owns `players` sees and gates only its own surface:

```sh
gqlcov report -s apollo:my-graph@current --html .gqlcov/report.html           # or a file from rover supergraph fetch
gqlcov report -s cosmo:default/my-graph --html .gqlcov/report.html            # subgraph SDLs are fetched too
gqlcov gate .gqlcov/report.json --min-fields 70 --subgraph players          # one subgraph
gqlcov gate .gqlcov/report.json --min-fields 70 --subgraph '*'              # every subgraph must pass
```

Ownership comes from the `@join__type`, `@join__field` and `@join__enumValue` directives in an Apollo supergraph; `join__*`, `link__*`, `openfed__*`, `_entities` and `_service` are left out of the totals. A type or field defined in several subgraphs counts in each of them.

If you only have the API schema (an introspection endpoint, the router, or Cosmo's composed schema, which carries no join directives), pass one SDL per subgraph instead and ownership is read from what each one defines (`@external` fields are not owned). `cosmo:` does this for you; by hand:

```sh
gqlcov report -s http://localhost:4000/graphql --subgraph clubs=subgraphs/clubs.graphql players=subgraphs/players.graphql
```

The console summary gets a subgraph table, the HTML report gets a subgraph section and a filter, `diff` prints per-subgraph deltas, and `gate --subgraph` applies thresholds and the no-decrease check to the chosen subgraphs only. In the report JSON, every element carries `graphs` and `report.subgraphs` holds one summary per subgraph.

## Join with code coverage (Codecov, SonarQube, Coveralls, nyc)

gqlcov can emit its result in the two formats coverage services already ingest, with every schema element mapped to its real line in the SDL file. The service then shows `schema.graphql` next to your source files, highlights untested fields in red, and tracks the trend and PR deltas for free.

```sh
gqlcov report -s schema.graphql --lcov .gqlcov/lcov.info --istanbul .gqlcov/coverage-final.json
```

Mapping:

| Coverage concept | gqlcov meaning |
| --- | --- |
| Line | an output field, input field or enum value (hit when requested or sent) |
| Function | a root operation field on Query, Mutation or Subscription |
| Branch | each argument of a field; for an optional input field, the arms *sent* and *omitted*; for an input field that accepts null, one more arm *null* |

So "80% lines, 50% functions, 57% branches" reads as: 80% of the schema surface was touched, half the operations ran, and 57% of arguments and input states (sent, omitted, null) were exercised.

- **Codecov / Coveralls**: upload `.gqlcov/lcov.info` as one more coverage file alongside your Jest or c8 output. Flag it (`-F schema`) to get a separate trend line.
- **SonarQube**: add `.gqlcov/lcov.info` to `sonar.javascript.lcov.reportPaths` (Sonar reads LCOV for any file the project contains).
- **nyc / Istanbul**: drop `coverage-final.json` into nyc's temp dir and report with `--extension .graphql`, or merge it with your code coverage:

  ```sh
  npx nyc report --temp-dir .nyc_output --reporter=lcov          # code coverage as usual
  npx istanbul-merge --out merged.json .nyc_output/*.json .gqlcov/coverage-final.json
  ```

When `--schema` is an endpoint or introspection JSON there is no SDL file for the line numbers to point at, so gqlcov prints one to `--schema-out` (default `.gqlcov/schema.graphql`) and references that. Commit it or upload it with the report so the service can display it.

## CLI

```
gqlcov report  -s <schema> [-c <dir>...] [-o report.json] [--html out.html] [--lcov lcov.info] [--istanbul coverage-final.json] [--exclude <pattern>...] [--subgraph name=file...] [--usage usage.json] [--persisted manifest.json...] [--include-deprecated] [--untested] [--sha] [--branch]
gqlcov usage   apollo <graph@variant> [--since ts] [--metric requests|executions] [-o usage.json]
gqlcov usage   cosmo <[namespace/]graph> [--range hours | --from iso --to iso] [-o usage.json]
gqlcov tests   <report> [--test name] [--json]     # coverage per test
gqlcov markdown <report> [--base report.json] [-o summary.md]
gqlcov comment <summary.md> [--id name] [--token t] [--repo owner/name] [--pr n]
gqlcov merge   <report>... -o merged.json          # parallel shards
gqlcov diff    <base> <head> [--json]
gqlcov gate    <report> [--min-fields n] [--min-input-fields n] [--min-input-null n] [--min-enum-values n] [--base report.json] [--tolerance points] [--subgraph name...|'*'] [--min-used-fields n] [--min-used-inputs n] [--require pattern...] [--max-invalid n]       # a missing --base file skips the no-decrease check
```

`gate --require` takes the same patterns and fails when any element they match is uncovered, which says "every mutation has a test" more directly than a percentage: `gqlcov gate .gqlcov/report.json --require "Mutation.*" "Query.payment*" "PaymentInput.*"`. A pattern that matches nothing fails too, so a typo cannot pass. Values of output-only enums count as covered once a response returned them.

Exclude patterns match `Type`, `Type.field`, `Type.field(arg)`, `Input.field` or `Enum.VALUE`, with `*` as a wildcard inside one segment: `--exclude "Query.__*" "Mutation.internal*" "LegacyInput.*"`. Deprecated elements and introspection types are excluded by default.

## Library

```ts
import { computeCoverage, readCaptures, gate, uncovered } from "@gqlcov/core";

const report = computeCoverage(sdl, readCaptures(".gqlcov/captures"), { exclude: ["Query.debug*"] });
report.summary.inputFields.percent;           // 70
report.inputTypes.MatchInput.fields.sets;     // { sent: 1, omitted: 1, required: false, values: { listMany: 1, ... } }
uncovered(report).enumValues;                 // ["Gender.M", "Surface.GRASS", ...]
gate(report, { minFields: 60, base: previousReport });
```

## CI (GitHub Actions)

The gqlcov Action posts one comment per pull request, updated on every push, and writes the same summary to the job page: the coverage table, the change against main, per-subgraph numbers, and collapsible lists of lost coverage, new schema elements without a test, and fields production uses but no test does.

```yaml
permissions:
  contents: read
  pull-requests: write                   # for the comment

steps:
  - run: GQLCOV_CAPTURE=1 npm run test:e2e
  - run: npx gqlcov report -s schema.graphql --html .gqlcov/report.html --lcov .gqlcov/lcov.info

  # The base: the report the last run on main saved. Caches from the default branch are visible to pull requests.
  - uses: actions/cache/restore@v4
    if: github.event_name == 'pull_request'
    with: { path: .gqlcov/base.json, key: gqlcov-main-${{ github.sha }}, restore-keys: gqlcov-main- }

  - uses: mimattan/gqlcov@v0.3.2         # the release that ships the Action
    with: { report: .gqlcov/report.json, base: .gqlcov/base.json }

  - run: npx gqlcov gate .gqlcov/report.json --min-fields 60 --base .gqlcov/base.json

  # On main, save this run's report as the next base.
  - if: github.ref == 'refs/heads/main'
    run: cp .gqlcov/report.json .gqlcov/base.json
  - if: github.ref == 'refs/heads/main'
    uses: actions/cache/save@v4
    with: { path: .gqlcov/base.json, key: gqlcov-main-${{ github.sha }} }
```

A missing base (the first run, or a fork) is fine: the summary shows coverage without a comparison and `gate --base` skips the no-decrease check. Inputs: `report`, `base`, `comment`, `summary`, `id` (separate comments for several reports on one pull request), `token`, `version` (defaults to the Action's own tag) and `cli`. Pull requests from forks get a read-only token, so the comment is skipped with a note while the job summary still appears.

Outside the Action, the same pieces are two commands:

```sh
gqlcov markdown .gqlcov/report.json --base .gqlcov/base.json -o summary.md
gqlcov comment summary.md                 # GITHUB_TOKEN, GITHUB_REPOSITORY and the event's pull request number
```

Codecov and friends still work alongside: upload `.gqlcov/lcov.info` (see above). For sharded suites, run `gqlcov merge` in a final job before the Action.

## Stale test queries

A captured document that no longer parses or validates against the schema is not counted toward coverage. It usually means a test or a fixture has drifted from the schema: a field was renamed or removed and the test kept sending the old query (against a mock, it may even still pass). gqlcov lists each one with its operation name, the validation errors, how often it was seen and the `source` labels of the tests that sent it, in the console, the HTML report and `report.invalid` in the JSON. Fail CI on them with:

```sh
gqlcov gate .gqlcov/report.json --max-invalid 0
```

## How coverage is computed

- Each captured document is parsed and validated against the schema. Invalid documents are counted, not analysed.
- Fields are walked with `graphql-js` `TypeInfo`, so fragments, interfaces and aliases resolve to the right schema field.
- Argument values are read as the client wrote them: variables (`$x`) as sent, literals without type coercion, so an input field's default value never counts as sent and enum values count by name. A variable that was not supplied counts as an absent argument or input field.
- Each value is walked against its input type: input-object fields are marked *sent* or *omitted*, enum values are counted, scalars and lists are classified. Lists recurse into their items; a bare value for a list type is treated as a one-item list, as GraphQL coercion does.
- A field counts as covered when it was requested at least once. An optional input field counts as "both states" when it was both sent and omitted somewhere in the run.
- An input field that accepts null counts as "sent as null" when a client sent an explicit `null` for it. For a partial update that is the "clear this value" case, and servers handle it inconsistently (some drop the null, some cannot tell it from an omitted field), so it is tracked as its own number: `summary.inputFieldsNull`, gated with `--min-input-null`. A null item inside a list does not count.

## Why not combinations

A mutation with 10 optional input fields has 1,024 presence combinations before any value is considered; nested inputs and enums multiply that. A metric defined that way sits near 0% forever and never gates anything. gqlcov tracks the finite, meaningful signals instead: was each field ever sent, ever omitted, ever null; was each enum value ever used; were empty, single and multiple lists seen. Where interactions between fields really matter, generate them with a property-based test suite rather than tracking them here. Pairwise reporting is on the roadmap as a separate, non-gating number.

## Development

```sh
npm install
npm run build
npm test
npm run test:coverage                   # fails if any package drops below 99% lines, statements, functions or branches
cd examples/yoga-e2e && npm run e2e     # capture -> report -> html -> gate against a Yoga server
```

CI runs the coverage check; the HTML report lands in `coverage/`.

## Roadmap

- Per-field join with resolver code coverage (Apollo Server, TypeScript): wrap resolvers to record which resolver ran for which schema field, then show both numbers per field.
- Pairwise input-field state reporting (non-gating).
- Cypress helper and a standalone reverse proxy for servers outside your control (a router in front of the subgraphs, for instance).

## Releasing

All five packages share one version.

1. `npm run set-version -- 0.2.0 && npm install`
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`

The `Release` workflow builds, tests, checks that the tag matches every package version, and publishes `core` first, then the CLI and capture packages, with npm provenance. It needs an `NPM_TOKEN` repository secret: an npm automation token (or granular token with publish rights on the `@gqlcov` scope).

## License

MIT
