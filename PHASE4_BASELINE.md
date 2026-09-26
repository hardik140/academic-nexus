# PHASE 4 — AUDIT BASELINE

Recorded **before** any Phase 4 testing, so that every later measurement has a
known starting state and any drift is visible.

No production system was contacted. No configuration was modified. No secret
value appears in this document or in any Phase 4 artefact.

---

## 1. Repository state

| | |
| --- | --- |
| Branch | `master` |
| HEAD | `a783c570b23a76ac459c71d0fd1c6f61b4a391ed` |
| HEAD subject | `ci: guard deployment job with CLOUDFLARE_API_TOKEN check` |
| Working tree | **dirty** — 11 modified, 10 untracked (below) |

The Phase 3 work is **entirely uncommitted**. That is itself a baseline fact
worth stating: the system under audit does not exist in any commit, so
"what is on disk" and "what is in git" are different systems.

**Modified (11)**

```
app/(portal)/admin/courses/actions.ts
app/(portal)/admin/departments/actions.ts
tests/staging-academic-period.test.ts
tests/staging-delete-cascade.test.ts
tests/staging-e2e.test.ts
tests/staging-hostel-finance.test.ts
tests/staging-mutations-hostel-finance.test.ts
tests/staging-mutations-period-tenant.test.ts
tests/staging-refund-atomicity.test.ts
tests/staging-security-definer.test.ts
tests/staging-security-f1-f2.test.ts
tests/staging/mutate.ts
```

**Untracked (10)**

```
PHASE3_REMEDIATION_REPORT.md
scripts/migrate-047-backfill.sql
supabase/migrations/051_phase3_hardening.sql
supabase/migrations/052_controlled_reopen_and_audit.sql
tests/authorization-surface.test.ts
tests/migration-047-populated.test.ts
tests/phase3-hardening.test.ts
tests/phase3-reopen-audit.test.ts
tests/staging-mutations-052.test.ts
tests/staging-mutations-phase3.test.ts
```

---

## 2. Migration state

| | |
| --- | --- |
| Migration files | **52** (`001` … `052`) |
| Latest | `052_controlled_reopen_and_audit.sql` |
| Applied anywhere? | **Unknown to this audit.** 051 and 052 are untracked and have never been committed; no environment was contacted to confirm what any deployed database actually has. |

This matters for Part 18/19: the audit can rehearse the chain, but it cannot
tell you what a real deployment is currently at.

---

## 3. Toolchain

| | |
| --- | --- |
| Node | v22.17.1 |
| npm | 11.5.1 |
| PostgreSQL (local, disposable) | **18.4** — `initdb`, `postgres`, `psql`, `pg_dump`, `pg_restore`, `pgbench` all present at `C:/Program Files/PostgreSQL/18/bin` |
| Test runner | vitest 5.0.1 |
| In-process PG | `@electric-sql/pglite` 0.5.8 |
| Framework | next 16.3.5, react 19.3.0 |
| Supabase | `@supabase/supabase-js` 2.116.0, `@supabase/ssr` 0.12.7 |
| Edge/queue | `@upstash/redis` 1.38.2, `@upstash/ratelimit` 2.1.0, `@upstash/qstash` 2.11.3 |
| Error tracking | `@sentry/nextjs` 10.70.0 |

Commands: `npm test` (`vitest run`), `npm run lint`, `npm run build`.
There is no `typecheck` script; `npx tsc --noEmit` is used directly.

---

## 4. What this environment CAN and CANNOT verify

Stated up front so no later section has to pretend.

### Can measure

- **Real multi-session PostgreSQL 18.4.** `tests/realpg/harness.ts` provisions
  a disposable cluster on loopback with trust auth and applies the full
  52-migration chain plus the QA dataset. Genuine concurrent sessions, real
  row locks, real transaction interleaving.
- **Load.** `pgbench` is present, so Phase 3's explicitly UNVERIFIED
  "trigger behaviour under load" can be measured rather than argued.
- **Backup/restore.** `pg_dump` and `pg_restore` are present.
- **Query plans.** `EXPLAIN ANALYZE` against the real cluster.
- Static inventories: RLS policies, constraints, `SECURITY DEFINER`
  functions, grants, API surface, dependency audit, secret scanning.

### Cannot measure — these will be reported UNVERIFIED, not PASS

| Area | Why |
| --- | --- |
| Browser / E2E workflows | No Playwright, Cypress, Puppeteer or WebDriver in `node_modules/.bin`. Nothing can drive a browser. |
| Device / camera workflows | No device, no emulator, no camera. |
| Deployed-application latency | No running deployment, no representative environment. Database-level latency **can** be measured and will be reported as such — it is not the same number. |
| What a production database currently contains | No environment was contacted, by design. |

---

## 5. Not implemented / not applicable

Established by inspection, so later parts do not invent findings:

| Part | Finding |
| --- | --- |
| 27 — Storage / file security | **NOT APPLICABLE.** No Supabase Storage usage anywhere in `app/` or `lib/` — no `storage.from(`, no bucket creation, no signed URLs. There are no buckets to audit. |
| 29 — Webhook / payment security | **NOT IMPLEMENTED.** No webhook route exists. `app/api/` contains `cron`, `finance`, `health`, `mobile`, `security` only. No payment gateway is integrated. |

---

## 6. Secrets — Part 33 result, recorded at baseline

Every tracked file was scanned for service-role keys, JWTs, private keys,
live Stripe keys, AWS access keys and Postgres URLs carrying a password.

**Result: NOT FOUND.** Eight files matched the pattern set; all eight matched
on a variable *name* or a placeholder, never a value:

| File | What matched |
| --- | --- |
| `.env.local.example` | `SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here` (placeholder) |
| `README.md`, `DEPLOYMENT_VERIFICATION.md` | the variable name in documentation |
| `lib/supabase/admin.ts` | `process.env.SUPABASE_SERVICE_ROLE_KEY \|\| "placeholder-service-role-key"` |
| `lib/finance/crypto.ts`, `scripts/*` | `process.env.…` references |

`.gitignore` covers `.env`, `.env.local`, `.env.development.local`,
`.env.test.local`, `.env.production.local`. Only `.env.local.example` and
`mobile/.env.example` are tracked, both placeholder-only.

18 environment variable names are referenced by code. Names only:
`GATE_QR_SIGNING_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `NODE_ENV`, `QSTASH_CURRENT_SIGNING_KEY`,
`QSTASH_NEXT_SIGNING_KEY`, `SMTP_FROM`, `SMTP_HOST`, `SMTP_PASSWORD`,
`SMTP_PORT`, `SMTP_USER`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPER_ADMIN_EMAIL`,
`SUPER_ADMIN_FULL_NAME`, `SUPER_ADMIN_PASSWORD`, `UPSTASH_REDIS_REST_TOKEN`,
`UPSTASH_REDIS_REST_URL`.

---

## 7. Dependencies — Part 34 result, recorded at baseline

`npm audit`:

```
critical 0   high 0   moderate 0   low 0   info 0   TOTAL 0
```

No advisories to triage, so no upgrade-compatibility risk to weigh.

---

## 8. Security configuration observed at baseline (Part 41)

From `next.config.ts`:

| Header | Value |
| --- | --- |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Content-Security-Policy-Report-Only` | present |

**`Content-Security-Policy` is Report-Only, not enforcing.** The config says
this is deliberate pending violation review. It is recorded here as a
baseline fact and carried into the findings as a hardening item, because a
report-only policy blocks nothing.

Sentry: `tracesSampleRate: 0.1`, `sendDefaultPii: false` on client, server and
edge.

Cookies/session: no explicit `sameSite` / `httpOnly` / `secure` / `maxAge` is
set anywhere in `lib/supabase/*` or `middleware.ts` — the app relies entirely
on `@supabase/ssr` defaults. Recorded as a fact; assessed in the findings.

---

## 9. Phase 3's own declared limitations, carried in

The Phase 3 report marked three things UNVERIFIED. Phase 4 must either close
them or repeat them honestly:

1. Browser / real-device workflows — **no tooling here either.**
2. Trigger behaviour under load — **measurable here** via pgbench.
3. What a deployed database contains — out of scope by design.

Phase 4 additionally does not take any Phase 3 PASS on trust. Part 2
re-derives them.

---

## 10. Audit rules in force

- Nothing is fixed during the audit.
- Temporary instrumentation is recorded, reverted, and the tree re-verified.
- "UI prevents it" and "the code looks right" are not evidence.
- Anything that cannot be reproduced is **UNVERIFIED**, never PASS.
