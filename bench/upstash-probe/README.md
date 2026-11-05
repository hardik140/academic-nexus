# Upstash latency probe

A standalone Worker that measures Worker → Upstash latency from Cloudflare's
network, against a **non-production** Upstash database, using the same client
libraries as the app. It shares nothing with the app: no routes, no KV, no app
secrets.

It exists because the Redis audit could not measure this: the only Upstash
database the project had was shared with production.

## What it measures

Per call (`?n=50` iterations, max 200):

| Field | What |
|---|---|
| `firstCommandInIsolateMs` | first command in a fresh isolate (connection set-up included); `isolateWasWarm` says whether it really was the first |
| `pingMs` | one round trip, p50 / p95 / p99 / max |
| `getMissMs`, `mgetTwoKeysMs` | the cache's read shapes |
| `payload.{1KB,10KB,100KB}` | SET and GET with JSON values of that size |
| `threeSequentialMs` vs `threeConcurrentMs` | three awaited GETs against three issued together (the client auto-pipelines them into one request) |
| `rateLimitCheckMs` | one `@upstash/ratelimit` sliding-window check, the app's per-request cost |
| `authFailureMs` | time to learn a token is refused |

## Safety

- Runs only when `REDIS_ENV` is `preview` or `staging` (the default in `wrangler.jsonc` is `preview`).
- Refuses a database whose host is in `FORBIDDEN_REDIS_HOSTS`. Set it to the production host.
- Every request needs the `x-probe-key` header to match `PROBE_KEY`.
- Writes only `<env>:nexus:probe:<uuid>:*` keys with a 120 s TTL, and deletes them before answering.
- Returns timings only. The error field is an error name, never a message, because Upstash messages embed the command.

## Owner steps (needs approval: creates a Worker on the Cloudflare account)

```sh
# 1. a NON-production Upstash database (Upstash console), then:
npx wrangler secret put UPSTASH_REDIS_REST_URL   --config bench/upstash-probe/wrangler.jsonc
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN --config bench/upstash-probe/wrangler.jsonc
npx wrangler secret put PROBE_KEY                --config bench/upstash-probe/wrangler.jsonc
npx wrangler secret put FORBIDDEN_REDIS_HOSTS    --config bench/upstash-probe/wrangler.jsonc   # the production host

# 2. deploy and run (5 rounds, 20 s apart)
npx wrangler deploy --config bench/upstash-probe/wrangler.jsonc
PROBE_KEY=… node bench/upstash-probe/run.mjs https://academic-nexus-upstash-probe.<account>.workers.dev/ 5 50

# 3. remove it afterwards
npx wrangler delete --config bench/upstash-probe/wrangler.jsonc
```

The result lands in `bench/results/upstash-latency-preview.json`, labelled
PREVIEW. Pick the Upstash region closest to where the Worker usually runs
(the `colo` field), or the numbers measure distance, not Redis.

## Local check

`bench/results/upstash-latency-local.json` is the same probe under
`wrangler dev` against the repository's Upstash stand-in
(`e2e/support/upstash-emulator.mjs`). It is labelled LOCAL and only shows
the probe works. It is not a latency measurement.
