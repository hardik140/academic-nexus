# Redis transformation — Phase 0 status

Program: "Academic Nexus — Redis Architecture Transformation Program" (owner
brief, 2026-10-04), derived from the Redis red-team audit (`f361b48`, verdict
ARCHITECTURALLY MIXED).

**Phase 0 gate: NOT PASSED — infrastructure-blocked.** The brief says to stop
here and report rather than pretend, so Phases 1–4 have not started. This
document is that report.

## 1. Baseline

Recorded on a clean worktree of `f361b48` (PR #123 head `d4d06e0` plus the
audit harness; no production-code difference from `d4d06e0`).

| Item | Result | Label |
|---|---|---|
| Commit | `f361b48` (production code identical to `d4d06e0`, PR #123 head) | — |
| Unit tests | 2869 in 90 files: 2866 passed, 3 timed out (20–60 s) while other servers ran on the machine; those 3 files pass alone, 43 / 43 | LOCAL |
| TypeScript | production code clean; 1 error in the audit harness (`bench/audit/finance-sync-race.audit.ts`), fixed on this branch | LOCAL |
| ESLint | 0 errors, 517 warnings | LOCAL |
| Production build, Worker build | pass on `d4d06e0` in CI run 37197858593 (built, not deployed); not re-run in the worktree, whose junctioned `node_modules` Turbopack refuses | CI |
| Full E2E / Redis E2E | 420 / 420 and 8 / 8 on `d4d06e0` (previous session); re-run on this branch, section 2 | LOCAL |
| Redis inventory | 46 cached reads (28 versioned), 93 rate-limit call sites over 88 buckets, 44 invalidation sites, 24 cached reads with an unbounded query | static analysis |
| Round trips | signed-in page 3 sequential Redis round trips; server action 7 | LOCAL, transfers |
| Stampede | 100 concurrent readers of a cold key → 100 database queries | LOCAL |
| Load model p95 (cold wave) | 100 users 388 ms · 500 users 1,182 ms · 1,000 users 1,897 ms · 5,000 users 6,326 ms; breaker opened from 1,000 users, and at 5,000 every warm read went to the database (10,000 queries) | LOCAL |
| Slow Redis (1 s) | high-risk action refused 503 in 1,011 ms; cached read at 500 ms latency served from the database in 1,027 ms | LOCAL |
| Findings reproduced | campus lockout (2,000 forged-cookie requests → 429 for signed-in and anonymous users), finance double posting (2 provider posts for one operation), plain-key invalidation race (suspended served as active) | LOCAL |
| Worker → Upstash latency, hit ratios, command rate, PostgreSQL p95 | **not measured** — no preview Redis, no preview Worker, no production telemetry | INFRASTRUCTURE-BLOCKED |

Raw results: `bench/results/baseline-redis-audit.json`, `bench/results/redis-inventory.json`.

## 2. What Phase 0 delivered (this branch)

| Item | State | Evidence |
|---|---|---|
| Redis metrics: one unsampled Analytics Engine data point per Redis event — command count and latency, cache hit / miss / stale / error / bypass / stored, timeouts, circuit state, rate-limit allowed / denied / fail-open / fail-closed, stored payload size — labelled by operation, route, environment and outcome | built, tested, **not deployed** | `lib/redis-metrics.ts`, `tests/redis-metrics.test.ts`, `tests/redis-integration.test.ts`, `REDIS_METRICS.md` |
| `wrangler.jsonc` binding `REDIS_METRICS` → dataset `nexus_redis_metrics` | committed, **not deployed** | takes effect on the next deploy you approve |
| Production Upstash credentials can no longer come from `.env.local`: `npm run cf:secrets` reads them from `.env.production.local` only, and refuses when that file names the same Upstash host or token as development | built, tested | `scripts/sync-cf-secrets.mjs`, `tests/sync-cf-secrets.test.ts` |
| Worker → Upstash latency probe: a standalone Worker using the app's client libraries; refuses production; cleans up its keys | built, validated LOCAL under `wrangler dev`, **not deployed** | `bench/upstash-probe/`, `bench/results/upstash-latency-local.json` |
| Stored value size is measured on each cache write (the miss path only) | built, tested | `lib/cache.ts`, `tests/redis-integration.test.ts` |

Found, not fixed (out of Phase 0 scope): the Upstash client stores a string
value raw and parses it on read, so a cached string such as `"123"` would come
back as the number 123. No cached read returns a bare string today.

None of these changes Redis behaviour for any request: no key, TTL, limit,
failure policy or command count changed.

## 3. Gate

| Gate item | Status | Why |
|---|---|---|
| Redis environments separated | **BLOCKED** | Needs a second Upstash database. There is no Upstash management credential in this environment, and creating one is an account action. |
| Preview Redis available | **BLOCKED** | Same. |
| Preview Worker available | **BLOCKED** | Wrangler here is signed in with Workers write access, but deploying needs your approval (standing rule: no deploys without explicit instruction), and a preview Worker is pointless without a preview Redis. |
| Worker → Upstash latency measured | **BLOCKED** | The probe is ready; it needs the two items above. |
| Baseline recorded | DONE | Section 1. |
| No production Redis modified | DONE | Nothing in this phase touched Upstash. Every Redis test ran against the local stand-in. |

## 4. Exact steps to unblock (owner)

1. **Create two Upstash databases** in the Upstash console, in the region
   closest to where the Worker runs: one for production, one for
   development/preview. Do not reuse the current database for production;
   its token is on every developer machine.
2. **Put the production pair in `.env.production.local`** (git-ignored) as
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Put the
   development pair in `.env.local`.
3. **Push the production secrets:** `npm run cf:secrets -- --dry-run` first
   (names only), then `npm run cf:secrets`. It refuses if the two files name
   the same database.
4. **Revoke the old database's token** (or delete the database) once
   production runs on the new one. The first deploy on a new database starts
   every rate-limit window and cache entry empty, once.
5. **Run the latency probe** against the development/preview database:
   `bench/upstash-probe/README.md` (deploy, run five rounds, delete). Set
   `FORBIDDEN_REDIS_HOSTS` to the production host.
6. **Approve a deploy** that includes the `REDIS_METRICS` binding, or say
   which preview Worker to use, so hit ratios and command rates exist.

When steps 1–5 are done, re-run this gate. Phase 1 starts after it passes.

## 5. Phase 1 can be unblocked separately

Two Phase 1 items do not depend on any Redis infrastructure: the finance
double-posting fix (PostgreSQL only) and the campus-lockout fix (application
code, testable on the stand-in). If you want them before the gate passes,
say so; the brief's ordering otherwise holds them.
