#!/usr/bin/env node
/**
 * Start `next dev` for a latency run with the same isolation as the E2E
 * configs: every key from the local env files blanked (names only — values
 * are never read), Supabase on a closed loopback port, Redis pointed at the
 * local emulator in the `e2e` namespace.
 *
 *   node bench/serve-isolated.mjs <port> <emulatorUrl> [cwd]
 *
 * BENCH_WEBPACK=1 uses webpack (Turbopack refuses a node_modules junction
 * that points outside the project, as in a worktree sharing node_modules).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const [port, emulator, cwd = process.cwd()] = process.argv.slice(2);
const blanked = {};
for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  const path = join(cwd, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) blanked[m[1]] = "";
  }
}
const env = {
  ...process.env,
  ...blanked,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "bench-isolated-anon-key",
  NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
  ENABLE_SENTRY: "",
  NEXT_TELEMETRY_DISABLED: "1",
  REDIS_ENV: "e2e",
  REDIS_LOG_SAMPLE_RATE: "0",
  UPSTASH_REDIS_REST_URL: emulator,
  UPSTASH_REDIS_REST_TOKEN: "emulator-token",
};
const child = spawn(process.execPath, [join(cwd, "node_modules/next/dist/bin/next"), "dev", "--port", port, "--hostname", "127.0.0.1", ...(process.env.BENCH_WEBPACK ? ["--webpack"] : [])], {
  cwd,
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("exit", (code) => process.exit(code ?? 0));
