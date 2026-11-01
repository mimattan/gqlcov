// Usage: npm run set-version -- 0.2.0 && npm install
// Sets the version of every published package and the @gqlcov/* deps between them.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(1);
}
const dirs = [
  ...readdirSync("packages").map((d) => `packages/${d}`),
  ...readdirSync("examples").map((d) => `examples/${d}`),
];
for (const dir of dirs) {
  const file = `${dir}/package.json`;
  const pkg0 = JSON.parse(readFileSync(file, "utf8"));
  if (pkg0.private) {
    for (const deps of [pkg0.dependencies, pkg0.devDependencies]) {
      for (const name of Object.keys(deps ?? {})) if (name.startsWith("@gqlcov/")) deps[name] = version;
    }
    writeFileSync(file, JSON.stringify(pkg0, null, 2) + "\n");
    continue;
  }
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  for (const deps of [pkg.dependencies, pkg.peerDependencies, pkg.devDependencies]) {
    for (const name of Object.keys(deps ?? {})) if (name.startsWith("@gqlcov/")) deps[name] = version;
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name} -> ${version}`);
}
console.log("Now run npm install to refresh package-lock.json.");
