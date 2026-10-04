import { it, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

/**
 * Reproducible Redis latency measurement (brief §20) — LOCAL, against the
 * Upstash emulator on loopback, so it measures this code's behaviour (budget,
 * retries, circuit), not Upstash's network. Not a production figure.
 *
 *   npx vitest run -c vitest.bench.config.ts
 *
 * Writes bench/results/redis-latency-<label>.json. Run the same file against
 * another checkout (BENCH_LABEL=main) to compare implementations; it uses
 * only the APIs both versions share: checkRateLimit() and getCached().
 */

const PORT = Number(process.env.BENCH_EMULATOR_PORT ?? 3198);
const LABEL = process.env.BENCH_LABEL ?? "branch";
let emulator: ChildProcess;

async function mode(m: string, delayMs = 0) {
  await fetch(`http://127.0.0.1:${PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: m, delayMs }) });
}

beforeAll(async () => {
  emulator = spawn(process.execPath, ["e2e/support/upstash-emulator.mjs", String(PORT)], { stdio: "pipe" });
  await new Promise<void>((resolve) => emulator.stdout!.on("data", (d) => String(d).includes("listening") && resolve()));
});
afterAll(() => emulator?.kill());

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function measure(n: number, op: () => Promise<unknown>) {
  const samples: number[] = [];
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    try {
      await op();
    } catch {
      failures++;
    }
    samples.push(performance.now() - t);
  }
  const s = [...samples].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n, p50: r(pct(s, 50)), p95: r(pct(s, 95)), p99: r(pct(s, 99)), max: r(s[s.length - 1]), failures };
}

it("measures rate-limit and cache latency under healthy, slow and down Redis", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${PORT}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.stubEnv("REDIS_LOG_SAMPLE_RATE", "0");
  const silence = () => {};
  vi.spyOn(console, "warn").mockImplementation(silence);
  vi.spyOn(console, "log").mockImplementation(silence);
  vi.spyOn(console, "error").mockImplementation(silence);

  const results: Record<string, unknown> = { label: LABEL, where: "local, loopback emulator", at: new Date().toISOString() };
  const scenarios: Array<[string, string, number, number]> = [
    ["healthy", "healthy", 0, 300],
    ["slow (emulator answers after 3000 ms)", "slow", 3000, 15],
    ["down (connection dropped)", "down", 0, 15],
  ];

  for (const [name, m, delay, n] of scenarios) {
    vi.resetModules();
    const { checkRateLimit } = await import("@/lib/rate-limit");
    const { getCached } = await import("@/lib/cache");
    await mode("healthy");
    // Seed one cache entry and warm the connection, then switch the mode.
    await getCached("bench:dashboard:college-a:counts", 300, async () => ({ rows: 42 }));
    await checkRateLimit("recordPayment:bench-user", 1_000_000, 60);
    await mode(m, delay);
    results[name] = {
      protectedRateLimit: await measure(n, () => checkRateLimit("recordPayment:bench-user", 1_000_000, 60)),
      lowRiskRateLimit: await measure(n, () => checkRateLimit("saveAttendance:bench-user", 1_000_000, 60)),
      cachedRead: await measure(n, () => getCached("bench:dashboard:college-a:counts", 300, async () => ({ rows: 42 }))),
    };
  }
  await mode("healthy");
  writeFileSync(`bench/results/redis-latency-${LABEL}.json`, JSON.stringify(results, null, 2));
  console.info(JSON.stringify(results, null, 2));
}, 900_000);
