// Verifies that a finished `next build` contains no development-only routes.
//
// The component gallery lives at app/dev/**/page.dev.tsx, and `dev.tsx` is a
// page extension only in the `next dev` phase (next.config.ts). This script
// checks the build output itself rather than trusting that configuration:
// run it after `npm run build`; it exits non-zero if any /dev route, or any
// compiled app/dev output, made it into .next.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NEXT_DIR = ".next";
const failures = [];

if (!existsSync(join(NEXT_DIR, "BUILD_ID"))) {
  console.error("No finished build found in .next — run `npm run build` first.");
  process.exit(2);
}

for (const manifest of ["app-path-routes-manifest.json", "server/app-paths-manifest.json"]) {
  const file = join(NEXT_DIR, manifest);
  if (!existsSync(file)) {
    failures.push(`missing ${file} — cannot prove the build is clean`);
    continue;
  }
  const entries = JSON.parse(readFileSync(file, "utf8"));
  const routes = [...Object.keys(entries), ...Object.values(entries).map(String)];
  for (const route of routes) {
    if (/(^|\/)dev(\/|$)/.test(route)) failures.push(`${manifest} contains ${route}`);
  }
}

if (existsSync(join(NEXT_DIR, "server", "app", "dev"))) {
  failures.push(".next/server/app/dev exists — development-only pages were compiled");
}

if (failures.length > 0) {
  console.error("Development-only routes found in the production build:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("OK: the production build contains no /dev routes.");
