import { existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-verification configuration (Checkpoint 3A).
 *
 * ISOLATION IS THE POINT. The only Supabase project this repository knows
 * about is production-equivalent (owner decision D3), and .env.local also
 * carries live Redis, QStash and SMTP credentials. `next dev` loads
 * .env.local automatically, but it never overrides a variable that is
 * already set in the process — even to an empty string. So the test server
 * below is started with EVERY key named in any local env file blanked out
 * (names only: the values are never read here), and Supabase pointed at a
 * closed local port. Nothing this suite starts can reach a remote service,
 * and a secret added to .env.local later is neutralised automatically.
 *
 * Until a genuinely non-production project and role accounts exist, tests
 * here are limited to what needs no data: unauthenticated routing, the login
 * page, and the development-only component gallery (app/dev/gallery).
 */

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

const ISOLATED_ENV: Record<string, string> = {
  ...blankedLocalEnvKeys(),
  // Non-empty on purpose: lib/supabase/middleware.ts falls back to a
  // *.supabase.co placeholder host when these are empty. Port 9 (discard)
  // on loopback refuses immediately.
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-isolated-anon-key",
  NEXT_PUBLIC_APP_URL: BASE_URL,
  ENABLE_SENTRY: "",
  NEXT_TELEMETRY_DISABLED: "1",
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "chromium-mobile-375",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: `npx next dev --turbopack --hostname 127.0.0.1 --port ${PORT}`,
    url: `${BASE_URL}/login`,
    // Never attach to a server someone else started — it would carry the
    // real .env.local values. A dedicated port keeps this deterministic.
    reuseExistingServer: false,
    timeout: 240_000,
    env: ISOLATED_ENV,
  },
});
