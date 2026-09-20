# Deployment verification

Phases 49 and 50.

---

## 1. Secrets — nothing secret is committed

| Check | Result |
| --- | --- |
| `.env`, `.env.local`, `*.pem`, `*.key` anywhere in git history | **None.** Only `.env.local.example`, which holds names and no values |
| `GATE_QR_SIGNING_KEY` value in any tracked file | **Absent** |
| `.gitignore` covers `.env*` and `.dev.vars*` | Yes |
| Secret values printed in this audit | **None.** Only key *names* were ever read |

`.env.local` on this machine holds 20 keys. They were enumerated by name
only, never by value.

---

## 2. Environment variables

| Variable | Present locally | In the Cloudflare Worker |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Yes | **NOT VERIFIED** |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | **NOT VERIFIED** |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Yes | **NOT VERIFIED** |
| `QSTASH_CURRENT_SIGNING_KEY` / `_NEXT_SIGNING_KEY` / `_TOKEN` | Yes | **NOT VERIFIED** |
| `GATE_QR_SIGNING_KEY` | Yes | **NOT VERIFIED** — carried over unresolved from the previous audit |
| `FINANCE_CREDENTIAL_KEY` | **ABSENT** | **NOT VERIFIED** |
| `SMTP_*` | Yes | **NOT VERIFIED** |

Two things follow.

**`FINANCE_CREDENTIAL_KEY` is not set anywhere in this environment, and was
not even documented.** The finance integration hub fails closed without it —
`lib/finance/crypto.ts` refuses to seal a credential rather than storing
anything weaker, which is correct and is unit-tested. But it means **no
integration connection can be created until that key is provisioned**. It has
now been added to `.env.local.example` with generation instructions; the
value itself is not set and is not this audit's to set.

**Nothing in the Worker was verified.** Verifying means
`npx wrangler secret list`, which needs Cloudflare credentials this session
does not have. `scripts/sync-cf-secrets.mjs` exists to push them and now
includes `GATE_QR_SIGNING_KEY`, but **it has not been observed to run**.

---

## 3. Secret storage — a production blocker for one feature

`FINANCE_CREDENTIAL_KEY` encrypts third-party accounting credentials. The key
itself lives in the process environment. **There is no KMS, no Vault and no
HSM in this repository.**

Migration 049's own header records this rather than papering over it. Repeated
here because it is a real blocker for the finance integration feature: an
environment variable is readable by anything that can read the process
environment, and there is no rotation story beyond `key_version` on the row.

**Status: OPEN — PRODUCTION BLOCKER for the finance integration hub.** The
rest of the application does not depend on it.

---

## 4. Migrations

| Check | Result |
| --- | --- |
| Chain applies 001 → 050 from empty | **PASS** — `tests/staging-migration-chain.test.ts`, every run |
| Idempotent on re-apply | **PASS** — including recovery from a partially-applied 047/049 (orphaned-index reclaim) |
| 050 refuses to run without 047 | **PASS** — preflight raises `undefined_function` |
| Hosted project is at 050 | **PASS** — read-only check. 050's preflight would have raised had 047 been incomplete |
| Rollback | **NOT TESTED** — see §6 |

There is no migration 048. The numbering skips it deliberately.

---

## 5. Headers, CORS, CI

| Item | Status |
| --- | --- |
| Security headers on every route | **PASS** — runtime-verified with `curl` in the previous audit |
| `Permissions-Policy: camera=(self)` on `/security/scanner` only | **PASS** — runtime verified; `/login` returns `camera=()` |
| CORS | No custom CORS. Mobile uses Bearer tokens against same-origin routes |
| Cron endpoints refuse without QStash keys | **CODE VERIFIED** in all five; runtime **NOT TESTED** |
| CI workflow | Syntactically valid, triggers on `master`. **HAS NEVER EXECUTED A RUN** |
| Lint in CI | `continue-on-error: true` — `typescript-eslint` has no TypeScript 7 support, and ESLint without it silently lints zero `.ts` files and exits 0 |

The CI row is the important one. A workflow that has never run is not a
control; it is a file.

---

## 6. Backup and recovery (Phase 50) — NOT TESTED

| Item | Status |
| --- | --- |
| Database backup exists | Supabase-managed. **Not confirmed by this audit** |
| Restore has been performed | **NO** |
| Migration rollback strategy | Migrations carry rollback SQL in comments. **Never executed** |
| Accidental-deletion recovery | **NOT TESTED** |
| Audit-log recovery | **NOT TESTED** |
| Payment recovery | **NOT TESTED** |
| Gate-movement recovery | **NOT TESTED** |
| RPO | **UNKNOWN** |
| RTO | **UNKNOWN** |

Phase 50 says it plainly: *"Do not claim disaster recovery PASS without
actually testing restoration."* No restoration was performed, so there is no
PASS here, and RPO/RTO are unknown numbers rather than optimistic ones.

Testing this means restoring a Supabase backup into a scratch project and
timing it. It cannot be done against production.

---

## 7. What must happen before a production cutover

1. Provision `FINANCE_CREDENTIAL_KEY` in a real secret store — or accept the
   documented blocker and leave the finance integration hub disabled.
2. Push every secret to the Worker and verify with `wrangler secret list`.
3. Make CI actually run once, and read the result.
4. Perform one restore from backup and record RPO/RTO.
5. Open the scanner on a real device and complete one OUT/IN cycle.
6. Configure GoTrue's login and password-reset rate limits in the Supabase
   dashboard — the application cannot do it (see `REDIS_RATE_LIMIT_DESIGN.md` §9).
