# Performance and load

Phases 43, 44, 45.

## Summary: NOT TESTED

No load test of any kind was run. Nothing in this document is a capacity
statement.

---

## Why not

Load testing needs two things this pass did not have:

1. **A deployed environment.** The application is built for Cloudflare
   Workers. Latency measured from a developer machine in India against
   Upstash and hosted Supabase describes *that* path, not the in-region
   serverless path a real request takes. Reporting it as application latency
   would be misleading.
2. **Infrastructure that is not production.** The only Upstash instance and
   the only Supabase project configured here are the live ones. Driving
   1,000 or 5,000 synthetic users at them risks consuming request quota and
   degrading the rate limiter and cache for real users — turning a test into
   an incident.

Phase 43 itself warns against the mistake this would produce: *"Do not
confuse synthetic load capacity with production capacity."*

---

## The only numbers actually measured

From the live Upstash probe (`REDIS_RATE_LIMIT_DESIGN.md` §4), on a
developer machine, cold:

| Measurement | Value | What it actually is |
| --- | --- | --- |
| `PING` round trip | 639 ms | Cold TLS + HTTP handshake, India → Upstash |
| 50 concurrent `limit()` calls | 34 ms wall | Warm, pipelined |
| Full test suite, 46 files | ~14 min | Dominated by PGlite instances, not by the app |

Reported for completeness. **None of these is a production figure.**

---

## What is known about the shape of the load, without measuring it

Recorded from source so whoever runs a load test knows where to look first.

| Concern | Where | Note |
| --- | --- | --- |
| Unbounded `fees` pull | `finance/dashboard/page.tsx`, `finance/reports/page.tsx` | Both read every fee row and aggregate in JavaScript. Already flagged in-code. Caching hides it at low volume; it will not scale. |
| Unbounded `getFeeStats` | `finance/transactions/actions.ts` | Same shape, same in-code note. |
| RLS-heavy paths | every tenant table | Each policy calls `get_my_college_id()`. Behaviour on a large table is unmeasured. |
| Materialized views | `mv_*` | Refreshed every 15 min by QStash. Refresh cost unmeasured. |
| Connection pool | Supabase pooler | Not configured or measured here. |
| **Rate limiter as a bottleneck** | one HTTP round trip to Upstash per limited action | Adds Upstash latency to **every mutation**. Unmeasured in-region, and the most likely surprise. |

The last row is the one to measure first. Phase 44 asks specifically whether
rate limiting becomes the bottleneck, and with an HTTP-based limiter on the
critical path of every mutation, it is a real candidate.

---

## What a real load test must cover

1. In-region, against a deployed Worker.
2. A **separate** Upstash instance and a **separate** Supabase project.
3. Ramp 10 → 50 → 100 → 500 → 1,000 concurrent users.
4. Measure: API latency percentiles, database latency, lock waits, deadlocks,
   sequential scans, Redis ops/sec and failure rate, connection count.
5. Specifically: whether the added Upstash round trip dominates mutation
   latency, and whether the two unbounded fee queries fall over first.

**Until that is done, no capacity claim can be made about this system.**
