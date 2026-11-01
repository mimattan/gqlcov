# @gqlcov/capture-apollo

Apollo Server plugin that writes every executed operation to a capture folder for gqlcov.

```sh
npm install -D @gqlcov/capture-apollo
```

```ts
import { gqlcovCapturePlugin } from "@gqlcov/capture-apollo";
new ApolloServer({ schema, plugins: [gqlcovCapturePlugin()] });
```

Captures only when `GQLCOV_CAPTURE=1` or `NODE_ENV=test` (override with `enabled`).

Part of [gqlcov](https://github.com/mimattan/gqlcov): GraphQL schema coverage measured from what your E2E tests actually executed. See the main README for the full guide.

## License

MIT
