import { defineConfig } from "vitest/config";

/** Redis architecture audit measurements (bench/audit/*.audit.ts) — never part of the unit suite. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["bench/audit/**/*.audit.ts"],
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
