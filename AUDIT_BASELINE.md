# Academic Nexus — forensic baseline

Phase 0. What exists, what tests it, and what is actually at risk. Written by
inspecting the repository, not by reading earlier reports.

**Scope of this pass:** the whole repository, with depth concentrated on the
areas the previous audits left open — Redis and rate limiting, cache
isolation, external ERP data ownership, audit durability, and the residue of
the API error-disclosure work.

---

## 0. The environment this was assessed in

| Capability | Available here | Consequence |
| --- | --- | --- |
| PGlite (WASM PostgreSQL) | **Yes** | Real RLS, triggers, functions, the actual migration chain. This is the strongest evidence in the suite. |
| Real PostgreSQL binaries | **Yes — PostgreSQL 18** at `C:/Program Files/PostgreSQL/18/bin` | `tests/realpg-*.test.ts` run here. **True two-session concurrency IS proven.** (The harness searches that path, not `PATH`; an earlier `command -v initdb` check in this audit reported them absent and was wrong.) |
| Hosted Supabase credentials | Yes | Read-only verification only. Nothing was written to the hosted project. |
| Upstash Redis credentials | **Yes** | Rate limiter measured live. See `REDIS_RATE_LIMIT_DESIGN.md`. |
| Browser / Playwright | **No** | Every Phase 47/41 workflow is **NOT TESTED**. |
| Physical mobile device | **No** | Phase 48 is **NOT TESTED — REAL DEVICE REQUIRED**. |
| ESLint | **Blocked** | `typescript-eslint` has no TypeScript 7 support at any version (upstream #10940). Running it without the TS parser silently lints zero `.ts` files and exits 0 — a false green. CI marks the step `continue-on-error`. |

---

## 1. Request path, traced end to end

```
Browser / RN app
  → proxy.ts  (matcher: everything but static assets)
  → lib/supabase/middleware.ts
        · global IP bucket          (lib/rate-limit.ts, lib/client-ip.ts)
        · supabase.auth.getUser()   (re-validates the JWT against GoTrue)
        · profiles read, 20 s cache (ROUTING ONLY)
        · status must be 'active'
        · role → allowed route prefix, fails closed on an unknown role
  → Server Action  or  app/api/**/route.ts
        · requireRole() / requireRoleFromRequest()  ← re-reads role+status UNCACHED
        · zod parse of the payload
        · checkRateLimit(action:userId)
        · ownership / tenancy checks in the action
  → Supabase client (anon key + the caller's JWT)
  → PostgREST
  → PostgreSQL
        · RLS policies              ← the last line of defence
        · triggers, CHECK constraints, unique indexes
        · SECURITY DEFINER functions (gate security, refunds, finance hub)
  → response  (lib/api-errors.ts normalises every error)
```

The mobile API is not a second implementation. Each route handler calls the
same `*Core` function the web Server Action calls, through a `*ViaRequest`
wrapper that swaps a cookie session for a Bearer token. Authorization, rate
limiting and validation live inside `*Core`, so there is no transport that
skips a check. Verified across all 33 mobile routes.

---

## 2. Area table

Legend — **Tests**: `PGlite` real database, `unit` pure assertions,
`live` measured against real infrastructure, `none`.

| Area | Existing implementation | Tests | Risk | Required action |
| --- | --- | --- | --- | --- |
| Authentication | Supabase GoTrue. `getUser()` re-validates the JWT server-side on every request; identity is never read from the body. Migration 043 forces every new profile to `student`/`pending` regardless of client metadata. | unit + PGlite | **Low** for token forgery. **Open** for brute force — login never reaches this app | Configure GoTrue rate limits in the Supabase dashboard (§9 of the Redis doc) |
| RBAC | `requireRole()` / `requireRoleFromRequest()`; `lib/permissions.ts` matrix; `tests/rbac-matrix.ts` | unit + PGlite | Low | — |
| Route-level role gating | Middleware prefix map, **fails closed** on an unknown role | unit | Low | Fixed this pass: missing-profile branch also fails closed now |
| RLS | 50 migrations; every tenant table carries `college_id`; `get_my_college_id()` / `get_my_role()` | **PGlite, extensive** | Low | — |
| Multi-tenant isolation | RLS + composite FKs `(id, college_id)` on the finance hub | PGlite | Low | — |
| IDOR / BOLA | Server-side ownership checks in every `*Core`, then RLS underneath | PGlite | Low | — |
| Gate Security | Migration 050: HMAC-signed QR, `record_gate_movement()` state machine, immutable ledger | PGlite + unit | Low in DB. **Camera never exercised** | Real-device test |
| Finance ledger | Row-locking trigger, `approve_refund()`, refund ≤ outstanding | PGlite + **realpg, two real sessions** | Low | — |
| External ERP (Tally/BUSY/Zoho) | Migration 049 hub; provenance via `connection_id` → `(college, provider, external company)`; credentials AES-256-GCM, RLS-enabled with **no policy** | **PGlite, extensive** | Low | See `EXTERNAL_DATA_OWNERSHIP.md` |
| Credential storage | `FINANCE_CREDENTIAL_KEY` in the environment; no KMS/Vault/HSM | unit | **Recorded production blocker** | Provision a secret store |
| **Rate limiting** | `@upstash/ratelimit` sliding window, ~75 buckets keyed on `userId` | **live + unit** | **Was P1 — fixed this pass** | — |
| **Redis failure behaviour** | Was fail-open everywhere | **unit** | **Was P1 — fixed this pass** | — |
| **Cache isolation** | `lib/cache.ts`, keys scoped by college or user | **unit** | **Was P2 — fixed this pass** | — |
| Cron / QStash | All five routes verify the QStash signature and **refuse with 503** when signing keys are absent | none | Low | Runtime verification after deploy |
| Audit logging | `lib/audit.ts`; `audit_logs` has SELECT + INSERT policies and **no UPDATE or DELETE policy** → append-only under RLS | **unit** | **Was P2 — fixed this pass** | DB-trigger audit is the durable fix; deferred |
| Notifications | `notifications` table, `receiver_id = auth.uid()` read policy | PGlite | Low | — |
| File storage | **None.** `storage.from` appears nowhere. The `documents` table exists but no code reads or writes it, and it has no INSERT/UPDATE/DELETE policy | n/a | **Not applicable** | Drop the table or build the feature |
| API error disclosure | `lib/internal-error.ts` + `lib/api-errors.ts` | unit | **10 residual sites — fixed this pass** | — |
| Input validation | zod at every `*Core` entry | unit + PGlite | Low | — |
| Frontend | Server Actions and route handlers re-authorize; no trust in hidden fields | PGlite | Low | Browser test still **NOT TESTED** |
| Mobile | Same `*Core` path as web | unit (`tests/api-mobile.test.ts`) | Low | Device test **NOT TESTED** |
| Deployment | Cloudflare Workers via OpenNext; `scripts/sync-cf-secrets.mjs` | none | **Open** | `GATE_QR_SIGNING_KEY` in the Worker is unverified |
| CI | `.github/workflows/ci.yml` | — | **Open** | Has never executed a run |
| Backup / recovery | Supabase-managed PITR | none | **Open** | Never restored. See `DEPLOYMENT_VERIFICATION.md` |

---

## 3. Findings opened by this pass

| ID | Finding | Severity | Status |
| --- | --- | --- | --- |
| R-001 | Rate limiter failed open for **every** bucket when Redis was unconfigured or erroring — payments, refunds, invitations, role changes included. Silent. | **P1** | **FIXED** |
| R-002 | Global IP bucket keyed on `x-forwarded-for`, a client-writable header. Rotating it minted a fresh bucket per request. | **P1** | **FIXED** |
| E-001 | 10 sites still threw raw PostgreSQL text via `error?.message \|\| "fallback"` — a shape the earlier F-002 codemod did not match. Reachable from `/api/mobile/finance/payment`, `/invoice`, `/scholarship`, `/super-admin/create-college` and six more. | **P1** | **FIXED** |
| C-001 | Cache keys built with `?.` collapse to a literal `undefined` segment, which is one entry shared by every caller in that state, across colleges. | **P2** | **FIXED** |
| A-001 | `logAudit` discarded the insert result. A rejected audit write produced no exception, no log and no return value — the mutation happened, the record did not. | **P2** | **FIXED** |
| M-001 | Middleware returned `supabaseResponse` for an authenticated user with no profile row, skipping every check below it. | **P2** | **FIXED** |
| R-003 | Login and password reset go browser → GoTrue directly and never pass through this application's limiter. | **P1 (design)** | **OPEN — outside this repository** |
| R-004 | Rate-limit capacities were never derived from real traffic. | P3 | **OPEN — needs production traffic** |
| CR-001 | `/api/cron/*` return `error.message` to the caller on failure. Only a valid QStash signature reaches them. | P3 | **OPEN — low value, deliberate deferral** |
| D-001 | `documents` table is inert: no code, no write policy, no storage backend. | INFO | Decide: drop or build |
| A-002 | Audit rows are written by the application in a statement separate from the mutation. A process dying between the two still loses the record. | P2 | **OPEN — needs DB triggers, a schema change across every audited table** |
| T-001 | `realpg-concurrency`'s payment-vs-refund test pinned its interleaving with a fixed `pg_sleep(0.2)` — a bet on process startup, not a guarantee. It lost once in two full-suite runs. A flaky test in a security suite is corrosive: it trains readers to ignore a red result. | P2 (test) | **FIXED** — ordering is now a lock handshake with no clock in it. No assertion changed. |
| MOCK-001 | `tests/api-mobile.test.ts` let `insert()` resolve to `undefined`, a shape the real Supabase client cannot produce. Harmless while `logAudit` discarded the result; four tests failed on the mock the moment it stopped. | P3 (test) | **FIXED** — the mock now defaults to the client's actual contract. |
| T-002 | The suite's PGlite-backed files carry 60-second per-test timeouts. Under CPU contention on this machine, four of them exceeded that and failed **as timeouts, not as assertions** — the same files pass 86/86 in isolation and the whole suite passes clean. A GitHub Actions runner is considerably weaker than this machine, and **CI has never run**, so nobody knows whether the suite fits inside those timeouts there. | P2 (CI risk) | **OPEN — will be answered by the first CI run** |

---

## 4. What this baseline deliberately does not claim

- No browser has opened any page in this pass. Every Phase 41/47 item is
  **NOT TESTED**.
- No physical device has scanned a QR code. Phase 48 is **NOT TESTED —
  REAL DEVICE REQUIRED**.
- No load test was run. Phases 43–45 are **NOT TESTED**.
- No backup was restored. Phase 50 is **NOT TESTED**.
- No CI run has ever executed. Phase 49 is **PARTIAL**.
- `realpg` concurrency **does** run here and passes, against PostgreSQL 18
  with two real psql sessions. One of its six tests was **flaky**: it pinned
  an interleaving with a fixed `pg_sleep(0.2)` and lost that bet once in two
  full-suite runs. The ordering is now a lock handshake with no clock in it;
  no assertion was touched. Recorded as **T-001**.
