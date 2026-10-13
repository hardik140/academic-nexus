# Crash monitoring and System Health

How Academic Nexus reports crashes, what a report may contain, and how a
Super Admin reads them. **Sentry is not live**: no project, DSN or token is
configured anywhere. Verification status is at the end of this file.

## Design in one paragraph

Sentry, already a dependency, is the one place crash reports live. It does
the grouping, release tracking, retention and alerting. The application
captures errors centrally, removes personal and secret data **before**
anything leaves (`lib/observability/scrub.ts`), and drops errors it expects
(expired session, refused permission, offline, throttled, invalid input,
cancelled request). A Super Admin page reads Sentry server-side with a
read-only token. Nothing is stored in Supabase: no table, no migration, no
raw event store. Without configuration every path is a no-op, and the page
says "not configured" rather than "no issues".

```
Browser ── @sentry/nextjs (global handlers, error boundaries) ──scrub──► Sentry
Server (Worker) ── onRequestError (instrumentation.ts) ──scrub──► Sentry envelope (one fetch, 2 s)
                                                       └──► one JSON line → Cloudflare Workers logs
Super Admin ── /super-admin/system-health ── server fetch (event:read token) ──► Sentry API
```

## What is captured, where

| Source | Mechanism | File |
|---|---|---|
| Unhandled browser errors and promise rejections | the SDK's global handlers | `instrumentation-client.ts` |
| A page that fails to render in the browser | error boundary → `reportBoundaryError` | `app/(portal)/error.tsx`, `app/global-error.tsx` |
| Server Component renders, Route Handlers, Server Actions, proxy | Next.js `onRequestError` → `reportServerError` | `instrumentation.ts`, `lib/observability/server-report.ts` |
| Mobile app | `@sentry/react-native` (`sendDefaultPii: false`); unchanged here | `mobile/App.tsx` |

**No double counting.** An error the server threw reaches the browser with
a `digest`. The server already reported it, so the boundary does not report
it again (verified in a real browser against a local Worker, below).

**Server errors and the Worker.** `reportServerError` posts one Sentry
envelope with `fetch` instead of loading the Sentry Node SDK in the Worker
(the SDK's server side is unverified on OpenNext; an earlier
`instrumentation.ts` that loaded it was removed in `0cd27c6`, and the
`sentry.server.config.ts` / `sentry.edge.config.ts` it imported were dead
since then and are deleted here). It uses only `fetch`, `AbortSignal.timeout`
and `crypto.randomUUID`, all native to Workers. Every server error also
produces one scrubbed JSON line (`"event":"server.error"`) that Workers
observability (`wrangler.jsonc`) collects.

**Never throws, never changes a response.** Next.js sets the response before
it calls `onRequestError`; reporting cannot alter it. A failed, rejected or
redirected send logs one `observability.send` line without the event; a
hostile error object (throwing getters) is logged as `unreportable`.
**Latency:** Next awaits `onRequestError` before the failed request
finishes, so an unreachable Sentry adds at most ~2 s (`SEND_TIMEOUT_MS`) —
only to requests that already failed. Measured locally: 2.2–3.0 s against a
10 s mock.

## Privacy rules (enforced in `scrubEvent` / `scrubText`, tested in `tests/observability-capture.test.ts`)

- **Removed:** user identity, `extra`, request bodies, headers, cookies, query
  strings, source-code context and local variables in stack frames, console
  breadcrumbs, every Sentry context except `trace`, `os`, `browser`,
  `device`, `runtime`, `app`. Server reports carry only the error's type and
  message — never its other properties or its `cause`.
- **Redacted in any text:** JWTs; `Bearer`/`Basic` credentials; any
  credential-named key and its value in prose, query, header or JSON form
  (`access_token=`, `"password":`, `Cookie:`, `apiKey`, `secret`, `session`,
  `signature`); email addresses; UUIDs (record ids); provider ids and keys
  (`pay_…`, `order_…`, `sk_live_…`); roll/enrolment numbers (upper-case
  letters + digits, 6+); other long opaque keys (24+); numbers of 10+ digits
  (phone, card, account).
- **URLs and transactions:** path shape only; numeric and UUID-like segments become `:id`.
- **Bounded:** input cut to 2,000 characters before the patterns run (no
  slow-regex exposure), messages at 500, server stack frames at 30.
- **Kept:** error type, redacted message, code locations, route file path,
  route type, method, release, environment, Next.js digest.
- `sendDefaultPii: false`: no IP address or cookies from the SDK.
- **Over-redaction is deliberate:** codes like `PGRST116` or dates may be
  replaced in messages; Sentry's grouping is by stack, not message text.

**Expected errors** are decided by structured signals only — a `code`, a
class name, the browser's offline state — never by message wording: RBAC
codes (`UNAUTHENTICATED`, `SESSION_REVOKED`, `FORBIDDEN`, `INACTIVE`,
`COLLEGE_UNAVAILABLE`, `SESSION_LIMIT`), PostgREST's expired-JWT codes,
`RateLimitError`, `ZodError`, `AbortError`, and a browser `fetch` that never
reached the network. **Reported, not suppressed:** Postgres `42501` (a grant
or RLS defect), `ACCESS_CHECK_FAILED`, `RateLimiterUnavailableError`, and
any error merely *worded* like an expected one.

**Outside this feature:** Next.js itself logs an unhandled server error's raw
message and stack to the console, so the raw text already reaches Workers
logs today, with or without Sentry (observed in the local Worker run). Only
the `server.error` line and the Sentry event are scrubbed.

## Configuration (owner actions; none are set today)

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | **build** environment (inlined) | browser reports |
| `SENTRY_DSN` | Worker secret | server reports |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Worker secret | System Health page; source maps |
| `SENTRY_READ_TOKEN` | Worker secret | System Health page. A Sentry auth token with **`event:read` only** |
| `SENTRY_API_URL` | Worker secret, optional | must be an `https://` origin; `https://de.sentry.io` for an EU organisation |
| `SENTRY_AUTH_TOKEN`, `ENABLE_SENTRY=true` | build | source-map upload (`next.config.ts`, `withSentryConfig`) |

- `scripts/sync-cf-secrets.mjs` deliberately does not push the Sentry
  variables; it is unchanged. Set them with `npx wrangler secret put SENTRY_DSN`
  (and the others).
- **Build env baking:** `opennextjs-cloudflare build` bakes the build
  machine's `.env*` files into the bundle (`next-env.mjs`, applied only to
  unset keys). Keep Sentry tokens out of `.env.local` on the build machine
  unless they are meant to ship; Worker secrets take precedence.
- **Release and sampling:** the release is the build's commit
  (`NEXT_PUBLIC_REDIS_BUILD_ID`), the same for client and server. Traces are
  sampled at 10 %; errors are not sampled.
- **Source maps:** browser stacks are minified until a build runs with
  `ENABLE_SENTRY=true` and `SENTRY_AUTH_TOKEN` (`project:releases` scope).
  Server frames are bundle paths; no server source maps are uploaded.
- **CSP:** `connect-src` (report-only today) allows `https://*.ingest.sentry.io`;
  an EU or self-hosted ingest host must be added before CSP is enforced.

**Recommended Sentry settings (in Sentry's console):**
- **Data scrubbing:** keep Sentry's own server-side data scrubbing on as a
  second layer.
- **Rate limits:** set a per-key rate limit on the DSN. A browser DSN is public by design.
- **Inbound filters:** turn on inbound data filters (legacy browsers, extensions).
- **Alerts:** alert rules for "new issue" and "issue frequency above N/h" to
  the team. Alerting is Sentry's, not a parallel system here.
- **Retention:** retention is the Sentry plan's (90 days by default).
  Academic Nexus stores no crash data.

## System Health page — `/super-admin/system-health`

- **Access:** Super Admin only, enforced where the data is read. Each page
  calls `requireRole(["super_admin"])` before any Sentry call; no API route
  or Server Action exposes the reader. The proxy also keeps students, staff,
  wardens and the other portals out of `/super-admin/*` — but **not College
  Admins**: the proxy's pre-existing "Admin can access everything" rule lets
  `admin` load any path, so for `admin` the page check is the only boundary
  (`tests/observability-authz.test.ts` pins both facts). There is no
  college-scoped view; Sentry data is platform-wide.
- **List:** status, level, period, environment, release and text search.
  Every filter is allowlisted; free text is stripped of `:`, `!`, quotes and
  brackets and cut to 80 characters, so it cannot add its own Sentry search
  terms. Fixed page size of 50; Sentry's `X-Hits` total is shown with a note
  when only the first 50 are listed.
- **Detail:** counts and dates; the latest event's exception and code
  locations (never source code or variables); allowlisted tags only. A
  non-numeric id never reaches Sentry; an issue of another project in the
  same organisation is "not found".
- **The token:** read only on the server, sent only to the configured
  `https://` origin, never with a followed redirect (`redirect: "manual"`),
  never in a page, error message or log.
- **Links:** a Sentry link is rendered only if it is `https` on the
  configured Sentry host (or a `sentry.io` subdomain for sentry.io); any
  other link makes the whole response "unexpected".
- **Distinct states:** not configured (names the missing variables),
  unavailable (token refused, rate-limited, unreachable or unexpected
  response), or data. An empty list appears only when Sentry answered.
  Loading is the portal's existing route loading state.
- **Triage:** resolve, ignore and assign happen in Sentry (linked). The page
  only reads, so the token needs no write scope.

## Local verification (no Sentry, no Cloudflare account, no hosted resources)

1. `npx vitest run tests/observability-capture.test.ts tests/observability-dashboard.test.ts tests/observability-authz.test.ts`
2. Runtime: in a separate `git worktree` **without any `.env*` file**, with
   throwaway Route Handler/page harnesses that throw synthetic errors (never
   committed), build with fake values —
   `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SENTRY_DSN=http://<key>@127.0.0.1:<mock>/1 npm run build:worker`
   — confirm `.open-next/cloudflare/next-env.mjs` is empty, put
   `SENTRY_DSN=http://<key>@127.0.0.1:<mock>/2` in that worktree's
   `.dev.vars`, run a local mock that records envelopes, and
   `npx wrangler dev --local`. Never build the harness from a checkout that
   holds `.env.local`: its values would be baked in.

## Disable or roll back

- **Disable:** unset the DSNs. Every capture path becomes a no-op (verified
  in the local Worker), and the page shows "not configured".
- **Roll back:** revert the commit. There is no schema to undo.

## Status (2026-10-12)

| Item | Status |
|---|---|
| Scrubbing, expected-error filter, hostile/nested/oversized inputs | Implemented; unit-tested |
| Server capture in a **local** Worker (`wrangler dev`, workerd) against a mock Sentry | **Mock runtime verified** — one scrubbed envelope per failure, original status kept, expected errors dropped, slow Sentry bounded, no DSN = no send |
| Browser capture and boundaries in real Chromium against the local Worker and a mock | **Mock runtime verified** — global handler, global boundary, expected-error drop, server-digest dedupe, scrubbed before delivery |
| Portal boundary (`app/(portal)/error.tsx`) at runtime | Unit-tested only (needs a signed-in session) |
| Sentry reader inside workerd against a mock API | **Mock runtime verified** |
| System Health pages, all states, authorization for every role | Implemented; unit and render tests |
| Delivery to hosted Sentry | **Not verified** |
| Capture in the deployed Cloudflare Worker | **Not verified** |
| Mobile scrubbing to the same rules | Deferred |
| Sentry `tunnel` through our own Worker | Deferred (revisit if ad blockers drop reports) |
| In-app triage, college-scoped views, affected-college counts | Deferred (product decision; write scope or tenant tags) |
| Sentry project, DSN, tokens, alert rules | Owner action |

**Deliberately not built:** a Supabase crash-event table, a grouping engine,
a second alerting system. Sentry already does each of these.
