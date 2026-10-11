# S1 Gate 3 Report — Asia/Kolkata "today"

Owner decision D7: "today" is the Asia/Kolkata calendar day, from one helper module (`lib/format.ts`). The server-side UTC-date fix is a separate backend track.

Validated 2026-09-30 on the uncommitted working tree. Nothing is committed or merged.

**Verdict: S1 GATE 3 PASS — PROCEED TO GATE 4**

---

## 1. The defect

Production runs on Cloudflare Workers, whose clock is UTC. `new Date().getDay()` and `new Date().toISOString().split("T")[0]` therefore give the UTC day, which is still **yesterday in India from 00:00 to 05:30 IST** every night. Screens computed "today" that way.

## 2. Scope decision

The written Gate 3 acceptance criteria were not available in this session, so the gate was scoped from D7 and the S1 briefs ("no server-side business-logic change"):

- **In Gate 3:** screen code, meaning pages and components that compute "today" to display it or to pre-fill a form.
- **Not in Gate 3 (D7 backend track):** server actions and `lib` business rules that write a date to the database or decide an outcome from "today". These are listed in §5, unchanged.

## 3. Changes

Helper: `todayInTimeZone()` already existed in `lib/format.ts`. One derived helper was added beside it: `todayDayOfWeek()`, the Asia/Kolkata weekday, computed from `todayInTimeZone()` so the two cannot disagree.

| Screen | Before (UTC server) | After |
|---|---|---|
| Teacher timetable: TODAY badge | `new Date().getDay()` | `todayDayOfWeek()` |
| Student schedule: TODAY highlight and today's substitute teachers | `getDay()`, `toISOString().split("T")[0]` | `todayDayOfWeek()`, `todayInTimeZone()` |
| Teacher dashboard: today's classes and attendance | `getDay()`, `toISOString().split("T")[0]` | `todayDayOfWeek()`, `todayInTimeZone()` |
| Student hostel: today's mess menu | `getDay()` | `todayDayOfWeek()` |
| Teacher attendance: default register date | `toISOString().split("T")[0]` | `todayInTimeZone()` (lazy initial state) |
| Finance integrations: default sync range | `toISOString().slice(0, 10)` | `todayInTimeZone()` |
| Finance reconciliation: default date range | `toISOString().slice(0, 10)` | `todayInTimeZone()` |

Between 00:00 and 05:30 IST these screens used to show yesterday's timetable, mess menu and substitutes, and pre-filled yesterday's date. The attendance page also had a hydration mismatch in that window: the server rendered the UTC date and the browser the IST date. Both now compute the IST date.

Nothing else changed: 7 page files, `lib/format.ts` (one added function), one new test file. No query, permission, schema, server action or business rule changed. The teacher can still pick any attendance date; only the default moved.

## 4. Tests

`tests/today-contract.test.ts` (9 tests) runs the process in **UTC, like the Worker**, and pins the clock to 01:30 IST on Tuesday 29 Sep 2026 (Monday 20:00 UTC). A sanity test proves the server's own calendar says Monday there.

- `todayDayOfWeek`: Tuesday, not Monday; flips at IST midnight (18:29:59Z vs 18:30:00Z); explicit time zone honoured.
- Teacher timetable renders TODAY beside Tuesday, not Monday.
- Student hostel requests `day_of_week = 2` (Tuesday) from `mess_menu`.
- Student schedule requests substitutions for `2026-09-29`.
- Source guard: no page, component or hook takes today's date or weekday from `new Date().getDay()` / `new Date().toISOString()` date slicing. Server actions, route handlers and `lib` are outside the guard, by design (§2).

Adversarial mutations, each restored afterwards (working-tree diff hash identical):

| # | Mutation | Result |
|---|---|---|
| T1 | Timetable weekday back to `getDay()` | caught, 2 failing |
| T2 | Hostel mess-menu weekday back to `getDay()` | caught, 2 failing |
| T3 | Schedule substitution date back to UTC | caught, 2 failing |
| T4 | Teacher dashboard today back to UTC | caught, 1 failing |
| T5 | Attendance default date back to UTC | caught, 1 failing |
| T6 | Integrations sync range back to UTC | caught, 1 failing |
| T7 | Helper returns the server's weekday | caught, 4 failing |

7 of 7 caught.

## 5. Not changed: D7 backend "today" debt

These compute "today" on the UTC server and are wrong from 00:00 to 05:30 IST. Each writes data or decides an outcome, so each is a backend business-rule change for the D7 track, not Gate 3.

| Site | Effect |
|---|---|
| `lib/finance-status.ts` `computeEffectiveFeeStatus` | which fees count as overdue (finance rule; also used by screens) |
| `app/(portal)/finance/scholarships/actions.ts` | `awarded_date` written on award |
| `app/(portal)/placement-cell/drives/actions.ts` | `placement_date` written on placement |
| `app/(portal)/warden/transfers/actions.ts` | `vacated_date` written on room transfer |
| `lib/finance/pipeline.ts` | finance sync date (finance internals) |
| `app/(portal)/security/actions.ts` `securityTodayCounts` | guard's "today" OUT/IN counts start at 05:30 IST (server local midnight) |
| `app/(portal)/director/security/actions.ts` `startOfToday` | director security tiles' "today" window, same cause |

The two security counts are read-only displays, but they live in server actions in the gate-security area, so they were left for D7 rather than widened into Gate 3.

Not a defect: the student dashboard's placement-deadline countdown compares a `timestamptz` instant with now, which is time-zone independent. `lib/leave-impact.ts` iterates calendar dates, not "today".

## 6. Regression

| Check | Result |
|---|---|
| D5 diff | byte-identical to the validated D5 state |
| D5 focused | 299 / 299 (in the full unit run) |
| Gate 2 currency contract | 14 / 14 (in the full unit run) |
| Unit, full suite | 2301 / 2301, 70 files (2292 + 9 new) |
| TypeScript | 0 errors |
| ESLint | 0 errors, 518 warnings (unchanged) |
| Production build | passed |
| Worker / OpenNext build | passed (not deployed) |
| No-dev-routes | passed |
| Playwright, desktop + mobile 375 | 272 / 272, 0 retries (second run; see note) |
| axe | 18 / 18 axe tests; heavy gallery axe test 22.3 s and 22.8 s under full load (60 s local budget) |

Playwright note, classified as test infrastructure: the first full run failed before any test ran. The isolated `next dev` server did not answer `/login` within the 240 s `webServer` startup limit, and Next reported a slow filesystem (benchmark 837 ms, against about 200 ms in earlier runs). No server was left on port 3100. The unchanged suite was run again and passed 272 / 272. No test, timeout or config was changed.

## 7. Remaining debt

```text
Finance validateMappings failure handling
→ D7 / Backend Finance Readiness — BLOCKING DEBT
→ NOT FIXED
```

- D7 backend "today" sites in §5.
- `lib/utils.ts formatDate` (en-US) is still used by older screens; migrating display dates to `lib/format.ts formatDate` (en-IN, IST) belongs to the date-display work, not "today".
- Retained D5 debt: goal-creation baseline on failed metric read; best-effort device-token lookup; finance-readiness exclusions.

## 7a. Verdict

```text
S1 GATE 3 PASS — PROCEED TO GATE 4
```

M7 remains blocked. Gates 4 (DataTable keyboard accessibility) and 5 (sidebar accessibility) have not started.
