# gqlcov

Schema coverage for GraphQL APIs, measured from what your E2E tests actually executed.

gqlcov records every operation the server runs during a test run and compares it with the schema. It reports, per run:

- **Output coverage**: types, fields and arguments that were ever requested.
- **Input coverage**: for every field of every input type, whether it was ever *sent*, ever *omitted*, and ever sent as *null*. This is the part no other tool does.
- **Value classes**: which enum values were seen; per scalar whether empty, zero, negative and positive values were seen; per list whether empty, one and many were seen.
- **Operations**: how many queries, mutations and subscriptions ran, by name.

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

2. Run your E2E suite with `GQLCOV_CAPTURE=1`.

3. Report and gate:

   ```sh
   gqlcov report --schema schema.graphql --html .gqlcov/report.html --untested
   gqlcov gate .gqlcov/report.json --min-fields 60 --base main-report.json
   ```

   `--schema` accepts an SDL file, an introspection JSON file, or an `http(s)://` endpoint (add `-H "Authorization: Bearer ..."`).

Console output looks like:

```
gqlcov: 5 operations (3 queries, 2 mutations, 0 subscriptions), schema 9c5b5e1aee01e655
  Types                                 100%  (6/6)
  Output fields                       71.43%  (15/21)
  Arguments                           42.86%  (3/7)
  Input-type fields sent                 70%  (7/10)
  Optional inputs sent and omitted    28.57%  (2/7)
  Enum values                         42.86%  (3/7)
```

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
| Branch | each argument of a field; for an optional input field, the two arms *sent* and *omitted* |

So "80% lines, 50% functions, 57% branches" reads as: 80% of the schema surface was touched, half the operations ran, and 57% of arguments and optional-input states were exercised.

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
gqlcov report  -s <schema> [-c <dir>...] [-o report.json] [--html out.html] [--lcov lcov.info] [--istanbul coverage-final.json] [--exclude <pattern>...] [--include-deprecated] [--untested] [--sha] [--branch]
gqlcov merge   <report>... -o merged.json          # parallel shards
gqlcov diff    <base> <head> [--json]
gqlcov gate    <report> [--min-fields n] [--min-input-fields n] [--min-enum-values n] [--base report.json] [--tolerance points]
```

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

```yaml
- run: GQLCOV_CAPTURE=1 npm run test:e2e
- run: npx gqlcov report -s schema.graphql --html .gqlcov/report.html --lcov .gqlcov/lcov.info
- uses: codecov/codecov-action@v4
  with: { files: .gqlcov/lcov.info, flags: schema }
- uses: actions/download-artifact@v4
  with: { name: gqlcov-main, path: base }
  continue-on-error: true
- run: npx gqlcov gate .gqlcov/report.json --min-fields 60 --base base/report.json || true   # drop `|| true` once the baseline exists
- uses: actions/upload-artifact@v4
  with: { name: gqlcov-${{ github.ref_name }}, path: .gqlcov/report.* }
```

For sharded suites, upload each shard's report and run `gqlcov merge` in a final job.

## How coverage is computed

- Each captured document is parsed and validated against the schema. Invalid documents are counted, not analysed.
- Fields are walked with `graphql-js` `TypeInfo`, so fragments, interfaces and aliases resolve to the right schema field.
- Argument values come from variables (`$x`) or literals (`valueFromAST`). A variable that was not supplied counts as an absent argument.
- Each value is walked against its input type: input-object fields are marked *sent* or *omitted*, enum values are counted, scalars and lists are classified. Lists recurse into their items; a bare value for a list type is treated as a one-item list, as GraphQL coercion does.
- A field counts as covered when it was requested at least once. An optional input field counts as "both states" when it was both sent and omitted somewhere in the run.

## Why not combinations

A mutation with 10 optional input fields has 1,024 presence combinations before any value is considered; nested inputs and enums multiply that. A metric defined that way sits near 0% forever and never gates anything. gqlcov tracks the finite, meaningful signals instead: was each field ever sent, ever omitted, ever null; was each enum value ever used; were empty, single and multiple lists seen. Where interactions between fields really matter, generate them with a property-based test suite rather than tracking them here. Pairwise reporting is on the roadmap as a separate, non-gating number.

## Development

```sh
npm install
npm run build
npm test
cd examples/yoga-e2e && npm run e2e     # capture -> report -> html -> gate against a Yoga server
```

## Roadmap

- Per-field join with resolver code coverage (Apollo Server, TypeScript): wrap resolvers to record which resolver ran for which schema field, then show both numbers per field.
- Test attribution: join the capture `source` label with per-test code coverage to answer "which test owns this field".
- Pairwise input-field state reporting (non-gating).
- Cypress helper and a standalone reverse proxy for servers outside your control.
- Map uncovered fields back to the test that should own them, using the `source` label.
- GitHub Action with PR annotations.
- Federation: coverage per subgraph.

## License

MIT
