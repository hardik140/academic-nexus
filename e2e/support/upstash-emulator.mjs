#!/usr/bin/env node
/**
 * A local stand-in for Upstash's REST API — enough of it for this app's
 * Redis use (lib/cache.ts, lib/rate-limit.ts) — with fault modes.
 *
 * WHY: the only Upstash database this repository knows is shared with
 * production (lib/redis-config.ts). Tests must never touch it, yet "Redis is
 * slow" and "Redis is down" have to be exercised against the REAL clients
 * (@upstash/redis's retry and abort handling, @upstash/ratelimit's script
 * protocol), not just against mocks. This server speaks the same wire
 * protocol on loopback.
 *
 * Supported: GET, SET (EX), DEL, MGET, INCR, EXPIRE, PING, EVALSHA/EVAL of
 * the sliding-window limit script, POST /pipeline and /multi-exec, and the
 * base64 response encoding the client asks for.
 *
 * Control (loopback only):
 *   POST /__mode   {"mode":"healthy"|"slow"|"down"|"malformed"|"auth","delayMs":3000}
 *   POST /__reset  clears data, recorded keys and counters
 *   GET  /__state  { mode, requests, keys: [...distinct keys seen] }
 *
 * "down" destroys the socket without answering (the client sees a network
 * error and retries). "slow" answers after delayMs. "malformed" answers 200
 * with a body that is not JSON. "auth" answers 401 like a revoked token.
 *
 * Usage: node e2e/support/upstash-emulator.mjs [port]   (default 3199)
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.UPSTASH_EMULATOR_PORT ?? 3199);

let mode = "healthy";
let delayMs = 0;
let requests = 0;
const data = new Map(); // key -> { value: string, expiresAt: number | null }
const seenKeys = new Set();

function live(key) {
  const entry = data.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    data.delete(key);
    return null;
  }
  return entry;
}

function see(...keys) {
  for (const k of keys) if (typeof k === "string") seenKeys.add(k);
}

function run(cmd) {
  const [rawName, ...args] = cmd;
  const name = String(rawName).toUpperCase();
  switch (name) {
    case "PING":
      return "PONG";
    case "GET": {
      see(args[0]);
      return live(args[0])?.value ?? null;
    }
    case "SET": {
      see(args[0]);
      let expiresAt = null;
      for (let i = 2; i < args.length; i++) {
        const opt = String(args[i]).toUpperCase();
        if (opt === "EX") expiresAt = Date.now() + Number(args[++i]) * 1000;
        else if (opt === "PX") expiresAt = Date.now() + Number(args[++i]);
      }
      data.set(args[0], { value: String(args[1]), expiresAt });
      return "OK";
    }
    case "DEL": {
      see(...args);
      let n = 0;
      for (const k of args) if (data.delete(k)) n++;
      return n;
    }
    case "MGET": {
      see(...args);
      return args.map((k) => live(k)?.value ?? null);
    }
    case "INCR":
    case "INCRBY": {
      see(args[0]);
      const by = name === "INCR" ? 1 : Number(args[1]);
      const entry = live(args[0]);
      const next = Number(entry?.value ?? 0) + by;
      data.set(args[0], { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    }
    case "EXPIRE":
    case "PEXPIRE": {
      see(args[0]);
      const entry = live(args[0]);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + Number(args[1]) * (name === "EXPIRE" ? 1000 : 1);
      return 1;
    }
    case "EVALSHA":
    case "EVAL":
      return slidingWindow(args);
    default:
      throw new Error(`ERR emulator does not support ${name}`);
  }
}

/**
 * @upstash/ratelimit's single-region sliding-window `limit` script, in JS:
 * KEYS = [current, previous], ARGV = [tokens, now, window, incrementBy].
 * Returns [remaining, limit]; remaining -1 means "refused".
 */
function slidingWindow(args) {
  const numKeys = Number(args[1]);
  const keys = args.slice(2, 2 + numKeys);
  const [tokensRaw, nowRaw, windowRaw, incrementRaw] = args.slice(2 + numKeys);
  const [currentKey, previousKey] = keys;
  see(currentKey, previousKey);
  const tokens = Number(tokensRaw);
  const now = Number(nowRaw);
  const window = Number(windowRaw);
  const incrementBy = Number(incrementRaw ?? 1);
  const current = Number(live(currentKey)?.value ?? 0);
  const previousRaw = Number(live(previousKey)?.value ?? 0);
  const percentageInCurrent = (now % window) / window;
  const previous = Math.floor((1 - percentageInCurrent) * previousRaw);
  if (incrementBy > 0 && previous + current >= tokens) return [-1, tokens];
  const newValue = current + incrementBy;
  const entry = live(currentKey);
  data.set(currentKey, {
    value: String(newValue),
    expiresAt: newValue === incrementBy ? Date.now() + window * 2 + 1000 : entry?.expiresAt ?? null,
  });
  return [tokens - (newValue + previous), tokens];
}

function encode(result, base64) {
  if (!base64) return result;
  if (typeof result === "string") return result === "OK" ? "OK" : Buffer.from(result, "utf8").toString("base64");
  if (Array.isArray(result)) return result.map((r) => encode(r, base64));
  return result;
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/__mode") {
      const body = raw ? JSON.parse(raw) : {};
      mode = body.mode ?? "healthy";
      delayMs = Number(body.delayMs ?? 0);
      return reply(res, 200, { mode, delayMs });
    }
    if (path === "/__reset") {
      data.clear();
      seenKeys.clear();
      requests = 0;
      mode = "healthy";
      delayMs = 0;
      return reply(res, 200, { ok: true });
    }
    if (path === "/__state") {
      return reply(res, 200, { mode, delayMs, requests, keys: [...seenKeys] });
    }

    requests++;
    const respond = () => {
      if (mode === "down") return req.socket.destroy();
      if (mode === "auth") return reply(res, 401, { error: "WRONGPASS invalid or missing auth token" });
      if (mode === "malformed") return reply(res, 200, "<html>gateway error</html>");
      const base64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
      let body;
      try {
        body = raw ? JSON.parse(raw) : [];
      } catch {
        return reply(res, 400, { error: "ERR invalid JSON" });
      }
      if (path === "/pipeline" || path === "/multi-exec") {
        return reply(
          res,
          200,
          body.map((cmd) => {
            try {
              return { result: encode(run(cmd), base64) };
            } catch (e) {
              return { error: e.message };
            }
          })
        );
      }
      try {
        return reply(res, 200, { result: encode(run(body), base64) });
      } catch (e) {
        return reply(res, 400, { error: e.message });
      }
    };
    if (mode === "slow" && delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`upstash-emulator listening on http://127.0.0.1:${port}`);
});
