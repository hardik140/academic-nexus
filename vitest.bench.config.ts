import { defineConfig } from "vitest/config";

/** Latency benchmarks (bench/*.bench.ts) — never part of the unit suite. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["bench/**/*.bench.ts"],
    testTimeout: 900_000,
    fileParallelism: false,
  },
});
