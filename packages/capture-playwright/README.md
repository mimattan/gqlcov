# @gqlcov/capture-playwright

Playwright helper that records GraphQL requests sent by the browser under test, with no server change.

```sh
npm install -D @gqlcov/capture-playwright
```

```ts
import { captureGraphQL } from "@gqlcov/capture-playwright";
test.beforeEach(async ({ page }, testInfo) => {
  await captureGraphQL(page, { endpoint: "/graphql", source: testInfo.title });
});
```

Part of [gqlcov](https://github.com/mimattan/gqlcov): GraphQL schema coverage measured from what your E2E tests actually executed. See the main README for the full guide.

## License

MIT
