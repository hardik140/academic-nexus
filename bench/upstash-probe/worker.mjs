/**
 * Upstash latency probe — a standalone Worker, separate from the app.
 *
 * WHY: the Redis audit could not measure Worker → Upstash latency, because
 * the only Upstash database is shared with production. This Worker measures
 * it from Cloudflare's network against a NON-PRODUCTION database, using the
 * same client the app uses (@upstash/redis, @upstash/ratelimit).
 *
 * SAFETY
 * - Refuses to run unless REDIS_ENV is "preview" or "staging".
 * - Refuses to run when the database host is listed in FORBIDDEN_REDIS_HOSTS
 *   (set this to the production host, comma-separated).
 * - Every request needs the x-probe-key header to equal PROBE_KEY.
 * - Writes only `<env>:nexus:probe:<random>:*` keys, each with a 120 s TTL,
 *   and deletes them before answering.
 * - Answers with timings only: no key, value, URL or token.
 *
 * Deploy and run: bench/upstash-probe/README.md
 */
import { Redis } from "@upstash/redis/cloudflare";
import { Ratelimit } from "@upstash/ratelimit";

let firstCommandDone = false;

const now = () => performance.now();
function summary(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10 : null);
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null };
}
async function timeEach(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await fn(i);
    out.push(now() - t);
  }
  return summary(out);
}

function refuse(status, error) {
  return Response.json({ ok: false, error }, { status });
}

const probe = {
  async fetch(request, env) {
    if (!env.PROBE_KEY || request.headers.get("x-probe-key") !== env.PROBE_KEY) return refuse(401, "missing or wrong x-probe-key");
    const redisEnv = (env.REDIS_ENV ?? "").trim();
    if (!["preview", "staging"].includes(redisEnv)) return refuse(412, "REDIS_ENV must be preview or staging");
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return refuse(412, "Upstash credentials are not set");
    let host;
    try {
      host = new URL(env.UPSTASH_REDIS_REST_URL).host.toLowerCase();
    } catch {
      return refuse(412, "UPSTASH_REDIS_REST_URL is not a URL");
    }
    const forbidden = (env.FORBIDDEN_REDIS_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (forbidden.includes(host)) return refuse(412, "this database is listed as forbidden (production)");

    const url = new URL(request.url);
    const n = Math.min(200, Math.max(5, Number(url.searchParams.get("n") ?? 50) || 50));
    const ns = `${redisEnv}:nexus:probe:${crypto.randomUUID()}`;
    // The app's client settings: one retry, no automatic deserialisation surprises.
    const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, retry: { retries: 1, backoff: () => 50 } });
    const result = { ok: true, label: "PREVIEW", environment: redisEnv, colo: request.cf?.colo ?? null, iterations: n, at: new Date().toISOString() };

    try {
      // 1. First command in this isolate (connection set-up included).
      const t0 = now();
      await redis.ping();
      result.firstCommandInIsolateMs = Math.round((now() - t0) * 10) / 10;
      result.isolateWasWarm = firstCommandDone;
      firstCommandDone = true;

      // 2. Single-command round trips.
      result.pingMs = await timeEach(n, () => redis.ping());
      result.getMissMs = await timeEach(n, (i) => redis.get(`${ns}:missing:${i}`));
      await redis.set(`${ns}:v`, "1", { ex: 120 });
      result.mgetTwoKeysMs = await timeEach(n, () => redis.mget(`${ns}:v`, `${ns}:missing`));

      // 3. Payload sizes (SET then GET), as the cache stores JSON.
      result.payload = {};
      for (const kb of [1, 10, 100]) {
        const value = JSON.stringify({ d: "x".repeat(kb * 1024) });
        const reps = Math.max(5, Math.floor(n / 5));
        result.payload[`${kb}KB`] = {
          setMs: await timeEach(reps, (i) => redis.set(`${ns}:p${kb}:${i}`, value, { ex: 120 })),
          getMs: await timeEach(reps, (i) => redis.get(`${ns}:p${kb}:${i}`)),
        };
      }

      // 4. Three commands: sequential vs issued together (auto-pipelined into one request).
      result.threeSequentialMs = await timeEach(n, async () => {
        await redis.get(`${ns}:a`);
        await redis.get(`${ns}:b`);
        await redis.get(`${ns}:c`);
      });
      result.threeConcurrentMs = await timeEach(n, () => Promise.all([redis.get(`${ns}:a`), redis.get(`${ns}:b`), redis.get(`${ns}:c`)]));

      // 5. The app's rate-limit check: one sliding-window script per call.
      const limiter = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(1000, "60 s"), prefix: `${ns}:rl`, timeout: 5000 });
      result.rateLimitCheckMs = await timeEach(n, (i) => limiter.limit(`probe-${i % 10}`));

      // 6. Failure latency: a refused token (no retry happens on an HTTP error).
      const wrong = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: "invalid-token-for-probe", retry: { retries: 1, backoff: () => 50 } });
      result.authFailureMs = await timeEach(5, () => wrong.ping().catch(() => null));
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.name : "error"; // never the message: it can embed the command
    } finally {
      // Clean up every key this run wrote (they also expire in 120 s).
      try {
        let cursor = "0";
        do {
          const [next, keys] = await redis.scan(cursor, { match: `${ns}:*`, count: 500 });
          if (keys.length) await redis.del(...keys);
          cursor = String(next);
        } while (cursor !== "0");
      } catch {
        /* keys expire on their own */
      }
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  },
};

export default probe;
