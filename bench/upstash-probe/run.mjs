#!/usr/bin/env node
/**
 * Calls the Upstash latency probe several times and records the results.
 *
 *   PROBE_KEY=… node bench/upstash-probe/run.mjs <probe-url> [rounds=5] [n=50]
 *
 * Writes bench/results/upstash-latency-<label>.json. The label is LOCAL when
 * the URL is on this machine (wrangler dev), PREVIEW otherwise: the probe
 * refuses to run against anything but a preview or staging database.
 * Rounds are spaced 20 s apart, so later rounds can land on other isolates.
 */
import { writeFileSync, mkdirSync } from "node:fs";

const [url, roundsArg = "5", nArg = "50"] = process.argv.slice(2);
if (!url || !process.env.PROBE_KEY) {
  console.error("usage: PROBE_KEY=… node bench/upstash-probe/run.mjs <probe-url> [rounds] [n]");
  process.exit(2);
}
const host = new URL(url).hostname;
const label = ["localhost", "127.0.0.1", "[::1]"].includes(host) ? "LOCAL" : "PREVIEW";
const rounds = Number(roundsArg);
const runs = [];
for (let r = 0; r < rounds; r++) {
  const t = performance.now();
  const res = await fetch(`${url}?n=${Number(nArg)}`, { headers: { "x-probe-key": process.env.PROBE_KEY } });
  const body = await res.json();
  runs.push({ round: r + 1, httpStatus: res.status, clientRoundTripMs: Math.round(performance.now() - t), ...body });
  console.log(
    `round ${r + 1}: status ${res.status}, colo ${body.colo ?? "-"}, first ${body.firstCommandInIsolateMs ?? "-"} ms, ` +
      `ping p50/p95/p99 ${body.pingMs ? `${body.pingMs.p50}/${body.pingMs.p95}/${body.pingMs.p99}` : "-"} ms, ` +
      `rate-limit p95 ${body.rateLimitCheckMs?.p95 ?? "-"} ms`
  );
  if (!res.ok || body.ok === false) break;
  if (r + 1 < rounds) await new Promise((s) => setTimeout(s, 20_000));
}
mkdirSync("bench/results", { recursive: true });
const out = `bench/results/upstash-latency-${label.toLowerCase()}.json`;
writeFileSync(out, JSON.stringify({ label, probedAt: new Date().toISOString(), runs }, null, 2) + "\n");
console.log(`wrote ${out} (${label})`);
