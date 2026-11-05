#!/usr/bin/env node
/**
 * Rate-limit algorithm comparison (audit section 8) — deterministic simulation.
 *
 * Each algorithm is implemented exactly as its Redis script computes it
 * (the sliding window mirrors @upstash/ratelimit's script, which the
 * emulator also implements), driven by attack traffic, and measured by the
 * worst case that matters for abuse: the most requests admitted inside ANY
 * rolling window of the nominal length.
 *
 * Redis cost per check is taken from the library source, not simulated:
 * every @upstash/ratelimit algorithm is one EVALSHA.
 *
 * Usage: node bench/audit/ratelimit-algorithms.mjs   (writes bench/results/ratelimit-algorithms.json)
 */
import { writeFileSync } from "node:fs";

const LIMIT = 30;
const WINDOW = 60_000;

const algorithms = {
  "fixed window": () => {
    const counts = new Map();
    return (t) => {
      const w = Math.floor(t / WINDOW);
      const n = counts.get(w) ?? 0;
      if (n >= LIMIT) return false;
      counts.set(w, n + 1);
      return true;
    };
  },
  "sliding window (current: @upstash/ratelimit approximation)": () => {
    const counts = new Map();
    return (t) => {
      const w = Math.floor(t / WINDOW);
      const current = counts.get(w) ?? 0;
      const previous = Math.floor((1 - (t % WINDOW) / WINDOW) * (counts.get(w - 1) ?? 0));
      if (previous + current >= LIMIT) return false;
      counts.set(w, current + 1);
      return true;
    };
  },
  "sliding log (exact)": () => {
    const log = [];
    return (t) => {
      while (log.length && log[0] <= t - WINDOW) log.shift();
      if (log.length >= LIMIT) return false;
      log.push(t);
      return true;
    };
  },
  "token bucket / GCRA (capacity = limit, refill limit per window)": () => {
    let tokens = LIMIT;
    let last = 0;
    return (t) => {
      tokens = Math.min(LIMIT, tokens + ((t - last) * LIMIT) / WINDOW);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  },
};

const patterns = {
  "boundary burst: limit just before and just after a window edge": () => [
    ...Array.from({ length: LIMIT }, (_, i) => 59_000 + i * 10),
    ...Array.from({ length: LIMIT }, (_, i) => 60_001 + i * 10),
  ],
  "steady abuse at 4x the limit for 10 minutes": () =>
    Array.from({ length: 10 * 4 * LIMIT }, (_, i) => Math.floor((i * WINDOW) / (4 * LIMIT))),
  "burst of 200 in one second, then silence": () => Array.from({ length: 200 }, (_, i) => 1_000 + i * 5),
  "legitimate: 25 clicks spread over a minute, repeated 5 minutes": () =>
    Array.from({ length: 125 }, (_, i) => Math.floor((i * WINDOW) / 25) + 7),
};

function worstRollingWindow(times) {
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] >= WINDOW) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

const out = {
  limit: LIMIT,
  windowSeconds: WINDOW / 1000,
  redisCost: {
    "fixed window": "1 EVALSHA, 1 key",
    "sliding window (current: @upstash/ratelimit approximation)": "1 EVALSHA, 2 keys",
    "sliding log (exact)": "1 EVAL, 1 sorted set of up to LIMIT members (ZREMRANGEBYSCORE + ZCARD + ZADD)",
    "token bucket / GCRA (capacity = limit, refill limit per window)": "1 EVALSHA, 1 hash (tokens + timestamp)",
  },
  results: {},
};
for (const [pname, gen] of Object.entries(patterns)) {
  const times = gen().sort((a, b) => a - b);
  out.results[pname] = {};
  for (const [aname, make] of Object.entries(algorithms)) {
    const allow = make();
    const admitted = times.filter((t) => allow(t));
    out.results[pname][aname] = { offered: times.length, admitted: admitted.length, worstInAnyRollingWindow: worstRollingWindow(admitted) };
  }
}
writeFileSync("bench/results/ratelimit-algorithms.json", JSON.stringify(out, null, 2) + "\n");
for (const [p, r] of Object.entries(out.results)) {
  console.log(p);
  for (const [a, v] of Object.entries(r)) console.log(`  ${a.padEnd(66)} admitted ${String(v.admitted).padStart(4)} / ${v.offered}   worst rolling ${LIMIT}-limit window: ${v.worstInAnyRollingWindow}`);
}
