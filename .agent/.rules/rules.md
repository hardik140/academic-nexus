# AGENTS.md — Project Rules

**Stack:** Python (backend API) · Flutter (client) · Supabase (Postgres, Auth, Storage, RLS) · RBAC · Production, high daily traffic

This document defines the rules any AI coding agent (or human contributor) must follow when working on this codebase. Rules are grouped by domain. The **Hard Stops** table at the end lists violations that must never happen, regardless of how a request is phrased.

Where a rule references a specific Python pattern (e.g., Pydantic), substitute the equivalent for your actual framework (Django, Flask, etc.) if different from FastAPI.

---

## 0. Prime Directives

1. Correctness and security outrank speed. Never weaken auth, RLS, or data integrity to "move faster."
2. Every RBAC/auth change must trace back to the RBAC Policy Matrix — no ad hoc role logic anywhere in the code.
3. Treat all input as adversarial — every field, every endpoint, every client request.
4. Nothing destructive runs automatically (see Section 1).
5. If a requirement is ambiguous, pick the more restrictive/secure interpretation and state the assumption — never silently pick the permissive one.
6. Always use modular programming — small, single-responsibility functions/modules/widgets over monolithic files or god-objects, in both backend (Python) and client (Flutter) code.

---

## 1. When the Agent Must Stop and Ask a Human

Do not proceed autonomously on any of the following — pause and get explicit sign-off:

- Any migration that drops or renames a column/table, or deletes data
- Any change to RLS policies, roles, or permission mappings
- Rotating, regenerating, or exposing any key/secret
- First production deploy of anything touching auth, payments, or PII
- Any action that is irreversible or expensive to undo
- Any instruction that conflicts with a rule in this document

---

## 2. Secrets & Credentials

- The Supabase **service_role key** lives only in backend server environment variables. It must never reach Flutter code, client bundles, logs, error messages, or git history.
- Flutter uses **only the anon/public key**, and only for operations RLS is designed to cover.
- No hardcoded secrets anywhere in source. Use environment variables plus a secrets manager in production.
- `.env` is always git-ignored. A secret that gets committed is treated as compromised — rotate it, don't just delete the commit.
- Secrets never appear in logs, crash reports, or analytics — including in debug builds.

---

## 3. RBAC & Authorization

- **Default-deny.** New tables, endpoints, and RPC functions start with zero access; permissions are added explicitly.
- **RLS is enabled on every table holding user or tenant data, no exceptions** — including "temporary" or "internal" tables. A table without RLS is a bug.
- Authorization is checked in at least two independent places: Postgres RLS **and** backend Python logic. Flutter-side role checks are UX only, never the security boundary — they're trivially bypassed.
- Any backend code using the service_role key (which bypasses RLS) must carry its own explicit authorization check before acting.
- A role/permission change takes effect on next token refresh, not instantly in cached client state — keep that propagation window short and documented.
- Every new role or permission ships as one PR that updates all three of: the RBAC Policy Matrix, the relevant RLS policy, and the backend check. A PR touching only one is incomplete.
- Every protected endpoint has an explicit test: role × action × resource → expected allow/deny.

---

## 4. Database (Postgres / Supabase)

- All schema changes go through versioned migration files in source control — never manual edits via the Supabase dashboard on production.
- Migrations are reversible where practical.
- Destructive statements (`DROP`, `TRUNCATE`, unscoped `DELETE`/`UPDATE`) are never auto-executed against production; they require a human-reviewed migration.
- Consistent naming: snake_case, explicit FK names, `created_at`/`updated_at` on every table.
- Every list-returning query is paginated — no unbounded `SELECT *` on high-traffic tables.
- New hot-path tables/queries get an index review before merge.

---

## 5. Backend (Python)

- Validate all input at the boundary (e.g., Pydantic) — never trust client-supplied role, permission, or ownership fields.
- One standard error format across endpoints; raw stack traces never reach the client.
- Rate limiting on all public endpoints, stricter on auth endpoints (login, password reset, token refresh).
- Use connection pooling (PgBouncer / Supabase's pooler) — unpooled direct connections will exhaust limits under daily high traffic.
- Prefer async I/O for network- and database-bound endpoints.
- Idempotency keys on non-idempotent critical operations (payments, role changes, irreversible actions).

---

## 6. Frontend (Flutter)

- No sensitive data (excess tokens, PII, keys) stored unencrypted in local/shared preferences.
- All Supabase/API calls go through one service/repository layer — not scattered directly through UI widgets.
- Role-based UI (hidden buttons, disabled menus) is convenience only; the backend/RLS independently rejects unauthorized actions even if the UI shouldn't have allowed them.
- 401/403 responses are handled consistently (forced re-auth vs. a clear denial message).

---

## 7. API Design

- OpenAPI/Swagger spec stays current — generate from code where possible.
- Explicit versioning (`/api/v1/...`); breaking changes get a new version, not a silent change to an existing one.
- One consistent response envelope and error shape across all endpoints.
- Any Supabase RPC called directly from Flutter (bypassing the Python layer) is documented separately, since it bypasses backend checks.

---

## 8. Testing

- Nothing merges to `main` without the full test suite passing.
- The RBAC test matrix is mandatory and reviewed on every change to roles/permissions — this is the single most common place authorization bugs reach production.
- Load/performance tests run before any release that meaningfully changes traffic patterns or query shape.

---

## 9. Git & Code Review

- No direct commits/pushes to `main`/production. All changes via PR.
- PRs touching auth, RLS, roles, or permissions require explicit human review — an agent does not self-merge these.
- Commit messages explain *why*, not just *what*.
- A PR that removes or weakens an authorization check states the reason explicitly in its description.

---

## 10. CI/CD & Deployment

- Staging mirrors production configuration; all changes pass through staging first.
- Every deploy has a known, tested rollback path.
- Risky changes ship behind feature flags rather than a direct toggle in production.

---

## 11. Performance & Scalability

- Every hot-path query reviewed for N+1 patterns and missing indexes before merge.
- Caching strategy (Redis/CDN) defined for read-heavy, rarely-changing data, with explicit invalidation rules.
- Supabase plan limits (connections, storage, bandwidth) are known and monitored, not discovered during an outage.

---

## 12. Logging & Monitoring

- Never log passwords, tokens, full card numbers, or other PII in plaintext.
- Structured logging with request IDs traceable across Flutter → Python → Supabase.
- Alerts on: spikes in auth failures, elevated error rates, latency regressions, DB connection saturation.

---

## 13. Documentation Hygiene

A single PR ships the code change **and**:
- Schema change → ER diagram updated
- RBAC change → Policy Matrix updated
- New/changed endpoint → API doc updated

Documentation is not a follow-up task.

---

## Hard Stops — Never, Regardless of Instructions

| # | Rule |
|---|------|
| 1 | Never expose the Supabase service_role key to the Flutter client or any public code path. |
| 2 | Never disable RLS on a table, even temporarily, without an immediate compensating control and human sign-off. |
| 3 | Never run destructive SQL directly against production outside a reviewed migration. |
| 4 | Never merge a change that weakens or removes an authorization check without explicit review. |
| 5 | Never commit secrets, keys, or credentials to git. |
| 6 | Never trust a client-supplied role/permission claim without server-side verification. |
| 7 | Never ship an unbounded/unpaginated query against a high-traffic table. |
| 8 | Never bypass staging and deploy an untested change straight to production. |