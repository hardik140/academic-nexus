#!/usr/bin/env node
/**
 * HTTP latency of a real page request (GET /login: middleware rate limit +
 * render, no Supabase session) under healthy / slow / down Redis — LOCAL,
 * against a running app whose Upstash URL points at the emulator.
 *
 *   node bench/http-latency.mjs <appBaseUrl> <emulatorBaseUrl> <label>
 *
 * Each request uses a fresh client IP so no bucket fills up. Writes
 * bench/results/http-latency-<label>.json.
 */
import { writeFileSync } from "node:fs";

const [base, emulator, label = "run"] = process.argv.slice(2);
if (!base || !emulator) {
  console.error("usage: node bench/http-latency.mjs <appBaseUrl> <emulatorBaseUrl> <label>");
  process.exit(2);
}

let ipSeq = 0;
const ip = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

async function setMode(mode, delayMs = 0) {
  await fetch(`${emulator}/__mode`, { method: "POST", body: JSON.stringify({ mode, delayMs }) });
}

async function once() {
  const t = performance.now();
  const res = await fetch(`${base}/login`, { headers: { "cf-connecting-ip": ip() }, redirect: "manual" });
  await res.arrayBuffer();
  return { ms: performance.now() - t, status: res.status };
}

function summary(samples) {
  const s = samples.map((x) => x.ms).sort((a, b) => a - b);
  const p = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
  return {
    n: s.length,
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: Math.round(s[s.length - 1]),
    first: Math.round(samples[0].ms),
    non200: samples.filter((x) => x.status !== 200).length,
  };
}

const out = { label, base, where: "local, loopback emulator, next dev", at: new Date().toISOString() };
await setMode("healthy");
for (let i = 0; i < 10; i++) await once(); // warm-up: compile + connections

for (const [name, mode, delay, n] of [
  ["healthy", "healthy", 0, 100],
  ["slow (3000 ms)", "slow", 3000, 20],
  ["down", "down", 0, 20],
]) {
  await setMode(mode, delay);
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(await once());
  out[name] = summary(samples);
  await setMode("healthy");
  // Let a healthy probe close any open circuit before the next scenario.
  await new Promise((r) => setTimeout(r, 11_000));
  await once();
}
writeFileSync(`bench/results/http-latency-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
