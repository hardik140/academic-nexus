import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "mobile/**"],
    // The RLS suites boot a real PostgreSQL (PGlite/WASM) per test, which
    // saturates the CPU and pushes the fast mock-based suites running
    // alongside them past the 5s default. That surfaced as intermittent
    // failures in unrelated files. These tests are pure assertions with no
    // I/O, so a generous ceiling costs nothing when they pass and it stops
    // the suite reporting load as a defect.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
