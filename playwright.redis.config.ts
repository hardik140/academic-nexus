import { existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Redis E2E: the real application, through real HTTP, with Redis enabled —
 * pointed at a LOCAL Upstash emulator (e2e/support/upstash-emulator.mjs),
 * never at Upstash. Run separately from the main suite:
 *
 *   npx playwright test -c playwright.redis.config.ts
 *
 * Same isolation rules as playwright.config.ts: every key from the local env
 * files is blanked, Supabase points at a closed loopback port, and the Redis
 * namespace is `e2e`. The emulator can be switched between healthy, slow,
 * down, malformed and auth-failure by the tests.
 *
 * Authenticated flows are out of reach here for the same reason as in the
 * main suite (owner decision D3: no non-production Supabase project); the
 * per-user bucket is covered by tests/middleware-rate-limit.test.ts.
 */

const PORT = 3101;
const EMULATOR_PORT = 3199;
const LOCAL_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

function blankedLocalEnvKeys(): Record<string, string> {
  const blanked: Record<string, string> = {};
  for (const file of LOCAL_ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match) blanked[match[1]] = "";
    }
  }
  return blanked;
}

export default defineConfig({
  testDir: "./e2e-redis",
  outputDir: "./test-results-redis",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "redis", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node e2e/support/upstash-emulator.mjs ${EMULATOR_PORT}`,
      url: `http://127.0.0.1:${EMULATOR_PORT}/__state`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx next dev --port ${PORT} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ...blankedLocalEnvKeys(),
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-isolated-anon-key",
        NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${PORT}`,
        ENABLE_SENTRY: "",
        NEXT_TELEMETRY_DISABLED: "1",
        REDIS_ENV: "e2e",
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${EMULATOR_PORT}`,
        UPSTASH_REDIS_REST_TOKEN: "emulator-token",
        REDIS_TIMEOUT_MS: "1000",
      },
    },
  ],
});
