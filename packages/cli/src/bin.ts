#!/usr/bin/env node
import { buildCli } from "./index.js";
buildCli().parseAsync(process.argv).catch((e) => {
  console.error(`gqlcov: ${(e as Error).message}`);
  process.exit(2);
});
