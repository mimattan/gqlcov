import { defineConfig } from "vitest/config";

/** Every package must keep at least this much coverage on every metric (`npm run test:coverage`, enforced in CI). */
const floor = { lines: 99, statements: 99, functions: 99, branches: 99 };
const packages = ["core", "cli", "capture-envelop", "capture-apollo", "capture-playwright"];

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      thresholds: Object.fromEntries(packages.map((p) => [`packages/${p}/src/**`, floor])),
    },
  },
});
