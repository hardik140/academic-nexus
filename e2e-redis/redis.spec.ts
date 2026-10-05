import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * The application under each Redis condition, end to end. Each test uses its
 * own client IP (CF-Connecting-IP, which the middleware keys on) so buckets
 * never leak between tests; the emulator is reset between tests.
 */

const EMULATOR = "http://127.0.0.1:3199";
const SESSION_COOKIE = "sb-e2eproject0000000-auth-token";

async function emulator(path: string, body?: unknown) {
  const res = await fetch(`${EMULATOR}${path}`, {
    method: path === "/__state" ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

let ipCounter = 10;
const nextIp = () => `198.51.100.${ipCounter++}`;

async function hit(request: APIRequestContext, ip: string, extra: Record<string, string> = {}) {
  const started = Date.now();
  const res = await request.get("/login", { headers: { "cf-connecting-ip": ip, ...extra }, maxRedirects: 0 });
  return { status: res.status(), retryAfter: res.headers()["retry-after"], ms: Date.now() - started };
}

test.beforeEach(async ({ request }) => {
  await emulator("/__reset");
  // Warm the route so compile time never counts as Redis latency, and let a
  // healthy call close the circuit if an earlier test left it open.
  await request.get("/login", { headers: { "cf-connecting-ip": "192.0.2.1" } });
});

test("anonymous traffic: one IP is held to 100 a minute and refused with Retry-After", async ({ request }) => {
  const ip = nextIp();
  // The limiter is a sliding window: when the run straddles a minute boundary
  // it admits a few more than the limit (bench/results/ratelimit-algorithms.json:
  // 31 for 30). So: at least the first 100 pass, and refusal comes by 110.
  let admitted = 0;
  let refused: Awaited<ReturnType<typeof hit>> | null = null;
  for (let i = 0; i < 120; i++) {
    const r = await hit(request, ip);
    if (r.status === 429) {
      refused = r;
      break;
    }
    expect(r.status).toBe(200);
    admitted++;
  }
  expect(admitted).toBeGreaterThanOrEqual(100);
  expect(admitted).toBeLessThanOrEqual(110);
  expect(refused?.status).toBe(429);
  expect(Number(refused?.retryAfter)).toBeGreaterThan(0);

  // Another IP is unaffected.
  expect((await hit(request, nextIp())).status).toBe(200);
});

test("a forged session cookie does not escape the anonymous limit", async ({ request }) => {
  const ip = nextIp();
  const cookie = { cookie: `${SESSION_COOKIE}=forged-token` };
  let refusedAt = -1;
  for (let i = 0; i < 105; i++) {
    const r = await hit(request, ip, cookie);
    if (r.status === 429) {
      refusedAt = i;
      break;
    }
  }
  expect(refusedAt, "forged sessions must still spend the per-IP bucket").toBeGreaterThan(0);
  expect(refusedAt).toBeLessThanOrEqual(100);
});

test("every key is in the e2e namespace and no raw client IP is stored", async ({ request }) => {
  const ip = "203.0.113.77";
  await hit(request, ip);
  await hit(request, ip, { cookie: `${SESSION_COOKIE}=x` });
  const { keys } = await emulator("/__state");
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(key.startsWith("e2e:nexus:"), key).toBe(true);
    expect(key).not.toContain(ip);
  }
});

for (const [mode, delayMs] of [
  ["slow", 4000],
  ["down", 0],
  ["malformed", 0],
  ["auth", 0],
] as const) {
  test(`Redis ${mode}: pages still load, within the budget, and the circuit makes later requests fast`, async ({ request }) => {
    await emulator("/__mode", { mode, delayMs });
    const ip = nextIp();
    const first = await hit(request, ip);
    expect(first.status).toBe(200);
    // One bounded Redis call (1000 ms budget) plus page rendering.
    expect(first.ms).toBeLessThan(2500);

    const later: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await hit(request, ip);
      expect(r.status).toBe(200);
      later.push(r.ms);
    }
    // The circuit opens after three failures; the last requests skip Redis.
    expect(Math.min(...later.slice(-2))).toBeLessThan(800);
  });
}

test("recovery: once Redis is healthy again, the app uses it again after the cooldown", async ({ request }) => {
  await emulator("/__mode", { mode: "down" });
  const ip = nextIp();
  for (let i = 0; i < 4; i++) expect((await hit(request, ip)).status).toBe(200);
  await emulator("/__mode", { mode: "healthy" });
  // The circuit's cooldown is 10 s; after it, one probe closes it.
  await new Promise((r) => setTimeout(r, 10_500));
  await hit(request, ip);
  const { requests } = await emulator("/__state");
  expect(requests).toBeGreaterThan(0);
});
