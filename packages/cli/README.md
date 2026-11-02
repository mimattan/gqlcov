# @gqlcov/cli

gqlcov command line: report, diff, gate and merge GraphQL schema coverage from captured operations.

```sh
npm install -D @gqlcov/cli
npx gqlcov report --schema schema.graphql --html .gqlcov/report.html --untested
npx gqlcov report --schema apollo:my-graph@current --usage .gqlcov/usage.json     # or cosmo:namespace/graph
npx gqlcov gate .gqlcov/report.json --min-fields 60 --base main-report.json
```

Part of [gqlcov](https://github.com/mimattan/gqlcov): GraphQL schema coverage measured from what your E2E tests actually executed. See the main README for the full guide.

## License

MIT
