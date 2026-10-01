# S1 Gate 2 Report — INR Currency

Owner decision D2: money is INR with en-IN (lakh/crore) grouping, shown through one formatter.

Validated 2026-09-30 on the uncommitted working tree. Nothing is committed or merged.

**Verdict: S1 GATE 2 PASS — PROCEED TO GATE 3**

---

## 1. Git state

| Item | Value |
|---|---|
| Branch | `feat/frontend-s1-ux-stabilization` |
| HEAD / base | `a424d9aa3ad40ffd4af3c920e9ba41562c7a0857` |
| Commits made | none |
| `main` / `master` | untouched |
| D5 work | present; the D5 diff is byte-identical to the validated D5 state |
| Gate 2 tracked files | 17 (14 web screens, `lib/format.ts`, `lib/utils.ts`, `mobile/src/lib/format.ts`) |
| Gate 2 new files | `tests/currency-contract.test.ts`, `mobile/src/lib/__tests__/format.test.ts`, this report |
| `git diff --check` | clean |

Gate 2 files:

- `app/(portal)/admin/users/page.tsx`
- `app/(portal)/director/decisions/page.tsx`, `app/(portal)/director/decisions/[id]/page.tsx`
- `app/(portal)/finance/dashboard/page.tsx`, `exceptions/page.tsx`, `integrations/reconciliation/page.tsx`, `invoices/page.tsx`, `refunds/page.tsx`, `reports/page.tsx`, `scholarships/page.tsx`, `transactions/page.tsx`
- `app/(portal)/student/dashboard/dashboard-client.tsx`, `student/fees/finance-requests-panel.tsx`, `student/fees/page.tsx`
- `lib/format.ts` (header comment only), `lib/utils.ts` (removed unused `formatCurrency`)
- `mobile/src/lib/format.ts`

## 2. Currency audit

Canonical formatter: `formatMoney` in `lib/format.ts` (already existed; unchanged). `Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" })`, exactly two decimals, `—` for missing or non-numeric values, `-0` shown as `₹0.00`. No new formatter was introduced on the web.

| Area | Before | After | Formatter |
|---|---|---|---|
| Finance dashboard (KPIs, recent transactions) | inline `Intl.NumberFormat("en-US", USD)`: `$125,000.00` | `₹1,25,000.00` | `formatMoney` |
| Finance invoices (amount, paid) | `formatCurrency` USD | INR | `formatMoney` |
| Finance transactions (4 KPIs, fee and payment columns, record-payment notice, outstanding balance) | `formatCurrency` USD | INR | `formatMoney` |
| Finance refunds (original payment, requested amount, processed list) | `formatCurrency` USD | INR | `formatMoney` |
| Finance scholarships (amount) | `formatCurrency` USD | INR | `formatMoney` |
| Finance reports (billed, collected, overdue, department breakdown) | `formatCurrency` USD | INR | `formatMoney` |
| Finance exceptions (flagged amounts) | `formatCurrency` USD | INR | `formatMoney` |
| Finance reconciliation (local, external, difference, item amounts) | local duplicate `toLocaleString("en-IN", INR)` | same output, one formatter | `formatMoney` |
| Admin users (student outstanding fees) | `formatCurrency` USD | INR | `formatMoney` |
| Student dashboard (fee rows: amount, paid, balance) | `formatCurrency` USD | INR | `formatMoney` |
| Student fees (totals, due banner, fee rows, payments) | `formatCurrency` USD | INR | `formatMoney` |
| Student fees request panel (refund notice, payment picker, request list) | `formatCurrency` USD | INR | `formatMoney` |
| Director decisions list and detail (financial impact) | `₹` + `toLocaleString()` with the runtime's default locale: grouping could be US | `₹12,34,567.00` | `formatMoney` |
| Mobile app, finance and student screens (8 screens, 25 amounts) | `formatCurrency` en-US, USD default | `₹1,25,000.00` | mobile `formatCurrency`, converted in place |

The mobile app (`mobile/`, Expo) cannot import the web `lib/`, so its one money formatter was converted in place to the same en-IN/INR output. Its signature lost only the unused `currency` parameter; all 25 callers are unchanged.

Not changed, by classification:

- **Placement packages** (`₹{package_lpa}L`, `₹{avg_package}L`, report buckets `₹5–10L`) on web and mobile. The stored value is already in lakhs per annum, so this is correct INR notation; `formatMoney` would render `12.5` as `₹12.50`.
- **Director analytics** `₹{collected / 100000}L collected`: an intentional compact lakh KPI subtitle, already INR.
- **Counts** via `toLocaleString()` (admin and director dashboard tiles, `StatsCard`): student, faculty and course counts, not money.
- **Dates** via `toLocaleString()` / `toLocaleDateString()`: out of Gate 2 scope (Gate 3 and the separate date track).
- **Form inputs** (`Amount`, `Financial impact ₹`, placeholder `₹40,000`): labels and user entry, not formatted values.
- **Dev gallery** `r.amount.toLocaleString("en-IN")` in `app/dev/gallery/demos.tsx`: development-only, excluded from production builds.
- **Backend** `currency: "INR"` in `lib/finance/pipeline.ts` and provider types: accounting payloads, not display. Untouched.

Visual change is limited to the currency text. `₹1,25,000.00` and `$125,000.00` are the same length; a crore value is one character longer. No typography, spacing, layout or component structure changed. No layout defect was observed; note that the browser suite has no data-backed pages (owner decision D3), so large live values were checked by server render, not in a browser.

## 3. Repository-wide currency search (after Gate 2)

Searched `.ts .tsx .js .mjs .cjs .md .json`, excluding `node_modules`, build output and lockfiles.

| Pattern | Remaining hits | Classification |
|---|---|---|
| `USD` | 10 | all legitimate, none in production code: 2 in the `lib/format.ts` comment, and 8 in tests asserting USD is absent (`tests/currency-contract.test.ts` 4, `tests/format.test.ts` 2, mobile `format.test.ts` 2) |
| `en-US` | 2 in production code | both date formatters, not money (`lib/utils.ts formatDate`, mobile `formatDate`); the other 4 hits are the `lib/format.ts` comment and the guard test |
| `currency:` | 1 display formatter | `lib/format.ts` only; the rest are backend INR payloads and provider types |
| `Intl.NumberFormat` | 2 | `lib/format.ts`, mobile `format.ts`, both en-IN/INR |
| `formatCurrency` | mobile only | mobile's single INR formatter and its 25 callers; web has none |
| `$` before an amount in UI | 0 | none |

**Remaining incorrect production money formatting: 0.**

## 4. Financial integrity

- No calculation changed. Every migrated call keeps its exact argument expression; only the formatter name changed.
- Displayed values are unchanged apart from currency formatting. Stored amounts are non-null numbers, and the two null-capable displays (decision financial impact) were already guarded.
- No database, schema, RLS, RBAC, tenant, API, server-action, cache, transaction, reconciliation or finance-readiness change.
- `validateMappings`, `activateConnection` and `lib/finance/*` are untouched.

## 5. D5 regression

| Check | Result |
|---|---|
| D5 diff | byte-identical to the validated D5 state (no D5 file touched) |
| D5 focused | 299 / 299 (`s1-failed-reads` 132, `read-failure-contract` 94, `s1-client-loaders` 5, `feedback-contract` 22, `lib/offerings.test` 46) |
| D5 exclusions | unchanged |
| `lib/cache.ts`, `lib/read-result-server.ts` | unchanged |
| New server-action failure paths | none |

## 6. Full validation

| Check | Result |
|---|---|
| Currency contract (new) | 14 / 14 |
| Formatter `tests/format.test.ts` | 30 / 30 |
| Unit, full suite | 2292 / 2292, 69 files (2278 + 14 new) |
| TypeScript | 0 errors (see note) |
| ESLint | 0 errors, 518 warnings (unchanged total) |
| Production build | passed |
| Worker / OpenNext build | passed (not deployed) |
| No-dev-routes | passed |
| Playwright, desktop + mobile 375, full parallel | 272 / 272, 0 retries |
| axe | 18 / 18 axe tests passed |
| Motion (`motion-contract` 80; e2e `motion`, `page-motion`) | all passed |
| Primitive motion | 27 / 27 |
| Feedback (`feedback-contract` 22, `feedback-components` 78, `m6-feedback` 40; e2e `feedback`) | all passed |
| Auth (`safe-redirect` 100, `authorization-surface` 9; e2e `auth-redirect` 14) | all passed |
| Mobile `jest` | 10 / 10 (2 suites, incl. the new formatter test) |
| Mobile `tsc --noEmit` | 0 errors |
| Mobile ESLint (changed files) | 0 problems |

Environment note, classified as an environment failure, not a Gate 2 regression: the first TypeScript and build runs failed on `.next/dev/types/validator.ts`, a file generated by `next dev`. It had been torn by two concurrent writers at 00:30 (a stray `e` between two copies of generated text); no source file was involved. It was not deleted: the full Playwright run starts its own isolated `next dev`, which regenerated it, after which TypeScript, the build and the Worker build all passed.

Heavy axe test: 34.5 s and 19.3 s in the full parallel run. The 34.5 s run would have failed the old 30 s default; it passed inside the 60 s local budget added in D5.

### Adversarial verification

Each mutation was applied to real source, the currency suite was run, and the file restored (working-tree diff hash identical before and after).

| # | Mutation | Result |
|---|---|---|
| G1 | Finance dashboard KPI back to `Intl.NumberFormat("en-US", USD)` | caught, 3 failing |
| G2 | Student fee row via `toLocaleString("en-US", USD)` | caught, 3 failing |
| G3 | Second INR formatter reintroduced on reconciliation | caught, 1 failing |
| G4 | Hand-built `₹{…toLocaleString()}` on decisions | caught, 2 failing |
| G5 | Reports KPI rendered unformatted | caught, 1 failing |

5 of 5 caught. The guard allows legitimate `₹…L` compact package values and INR backend payloads.

## 7. Remaining debt

```text
Finance validateMappings failure handling
→ D7 / Backend Finance Readiness — BLOCKING DEBT
→ NOT FIXED IN GATE 2
```

If the `fees` or `payments` read fails, `validateMappings` finds no mapping gaps, so `activateConnection` (the last gate before money can move) can activate a connection with incomplete mappings. Untouched in Gate 2.

Other currency-related items:

- **Mobile on-device check.** The mobile formatter is verified under Jest (Node ICU). Hermes' `Intl` on older Android builds may fall back to Western grouping (`₹125,000.00`), which is still INR. It should be confirmed on a device in the next mobile release.
- **Mobile release.** The mobile change reaches users only with the next Expo build; it has no effect on the web deploy.
- **Dates.** `lib/utils.ts formatDate` and mobile `formatDate` still use en-US; that belongs to the date track, not Gate 2.
- **Retained D5 debt:** goal-creation baseline on failed metric read; best-effort device-token lookup; finance-readiness exclusions.

## 8. Verdict

```text
S1 GATE 2 PASS — PROCEED TO GATE 3
```

M7 remains blocked until all S1 gates pass. Nothing has been merged.
