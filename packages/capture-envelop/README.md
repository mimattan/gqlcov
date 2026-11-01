# @gqlcov/capture-envelop

Envelop / GraphQL Yoga plugin that writes every executed operation to a capture folder for gqlcov.

```sh
npm install -D @gqlcov/capture-envelop
```

```ts
import { useGqlcovCapture } from "@gqlcov/capture-envelop";
createYoga({ schema, plugins: [useGqlcovCapture()] });
```

Captures only when `GQLCOV_CAPTURE=1` or `NODE_ENV=test` (override with `enabled`).

Part of [gqlcov](https://github.com/mimattan/gqlcov): GraphQL schema coverage measured from what your E2E tests actually executed. See the main README for the full guide.

## License

MIT
