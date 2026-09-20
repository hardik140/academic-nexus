# External ERP data — ownership and isolation

Phases 11–14. How Tally, BUSY and Zoho records map into Academic Nexus, and
what stops one college's data reaching another.

Everything asserted here is enforced by migration
`049_finance_integration_hub.sql` and tested against a real PostgreSQL
(PGlite) carrying the actual migration chain, in
`tests/staging-finance-integration.test.ts`.

---

## 1. The ownership chain

```
College (colleges.id)
   │  finance_integration_connections.college_id  — FK, ON DELETE CASCADE
   ▼
Integration Connection (finance_integration_connections.id)
   │  .provider ∈ {tallyprime, busy, zoho_books}
   │  .organization_id          — Zoho's organisation
   │  .external_company_id      — Tally's loaded company / BUSY's company
   │  .environment ∈ {production, sandbox}
   │  UNIQUE (college_id, provider, external_company_id)
   ▼
External Record (finance_external_links)
   .connection_id, .entity_type, .entity_id  — the Academic Nexus side
   .external_id, .external_number            — the provider's side
```

Worked example:

```
College A
  └─ Connection 6f2c… (provider=tallyprime, external_company_id=TALLY_COMPANY_001)
       └─ finance_external_links
            entity_type = 'payment'
            entity_id   = <payments.id in College A>
            external_id = 'VCH-123'
```

---

## 2. Provenance — what Phase 11 asks for, and where it lives

Phase 11 lists fields to look for. This schema does not carry them as flat
columns on each record; it carries the **connection id**, and every one of
those facts hangs off it. The composite is stronger, not weaker, because the
provenance cannot drift from the connection that produced it.

| Phase 11 field | Where it is |
| --- | --- |
| `source_system` | `finance_integration_connections.provider` |
| `source_organization_id` | `.organization_id` (Zoho) |
| `source_company_id` | `.external_company_id` (Tally, BUSY) |
| `external_record_id` | `finance_external_links.external_id` |
| `college_id` | on the connection **and** denormalised onto every child row |
| `sync_batch_id` | `finance_sync_operations.id` — the journal row that created the link |
| `last_synced_at` | `finance_sync_cursors`, plus `.last_success_at` on the connection |

### Rule 9 — external ids are not globally unique — HOLDS

Phase 11 suggests keying on `(source_system, external_company_id, external_record_id)`.
The implementation uses:

```sql
UNIQUE (connection_id, entity_type, external_id)   -- one local entity per external document
UNIQUE (connection_id, entity_type, entity_id)     -- one external document per local entity
```

`connection_id` already determines `(college, provider, external company)`, so
this is the suggested triple **plus** the tenant boundary and the entity type.
Two providers, or two companies on one provider, can both emit `INV-001`
without colliding.

The second constraint is the one that catches a reconciliation trying to
resolve two different payments onto the same voucher.

---

## 3. The tenant boundary is a foreign key, not a filter

Every child table carries `college_id` **and** a composite FK back to the
connection:

```sql
CONSTRAINT fel_connection_tenant_fkey
  FOREIGN KEY (connection_id, college_id)
  REFERENCES finance_integration_connections (id, college_id) ON DELETE CASCADE
```

backed by `ALTER TABLE … ADD CONSTRAINT fic_tenant_key UNIQUE (id, college_id)`.

This is the part that matters. A row claiming `connection_id` = a College A
connection while carrying `college_id` = College B **cannot be inserted at
all** — not because a policy rejects it, but because no such parent row
exists. It holds against the service-role client, against `psql`, and against
any future code path that forgets to filter.

Applies to: `finance_integration_credentials`, `finance_account_mappings`,
`finance_external_links`, `finance_sync_operations`, `finance_sync_cursors`,
`finance_reconciliation_runs`, `finance_reconciliation_items`.

---

## 4. Who may read and write what

| Table | authenticated SELECT | authenticated INSERT/UPDATE |
| --- | --- | --- |
| `finance_integration_connections` | own college, finance/admin/director | admin only, `DRAFT` only |
| `finance_integration_credentials` | **nobody** — RLS enabled, **no policy at all** | **nobody** |
| `finance_account_mappings` | own college | admin |
| `finance_external_links` | own college | **nobody** — written only by the service-role worker from a verified provider response |
| `finance_sync_operations` | own college | enqueue and cancel only; **an operator may never declare an outcome** |
| `finance_reconciliation_items` | own college | resolution fields only; the finding itself is immutable |

RLS enabled with **no policy** is PostgreSQL's deny-everything for any
non-owner role, including `authenticated` holding `admin`. It is not a
narrow policy that could be widened by mistake — there is nothing there to
widen.

Credentials are AES-256-GCM sealed before they reach the row
(`lib/finance/crypto.ts`), so the ciphertext is useless even to a reader who
somehow obtained one.

---

## 5. Phase 12 — the cross-tenant attack, tested

`tests/staging-finance-integration.test.ts`, section *"A College A connection
can never process College B data"*, runs each of these against a real
database as the real role:

| Attempt | Result |
| --- | --- |
| College B finance user lists College A's connections | 0 rows |
| College B finance user queues an operation on College A's connection | rejected |
| An operation straddling two colleges, **inserted from the console** with RLS out of the picture | rejected by the composite FK |
| An operation naming a payment from another college (§85 IDOR) | rejected |
| A mapping attached to another college's connection | rejected |
| Student / teacher / HOD / warden read any hub table | 0 rows, every table |
| Any authenticated role reads a credential | 0 rows; write rejected |

The third row is the important one: it is the test that does **not** rely on
RLS, and it still fails, because the constraint is structural.

---

## 6. Phase 14 — sync security

| Attack | Control | Tested |
| --- | --- | --- |
| Duplicate import | `UNIQUE (connection_id, entity_type, external_id)` | Yes |
| Replayed operation | Deterministic idempotency key; `UNIQUE` on the journal | Yes |
| Retry after an **unknown** outcome | Refused — `RETRYING` is only reachable when the previous outcome was classified safe | Yes |
| Duplicate external id | Both uniqueness rules above | Yes |
| Re-aiming a journal row at another payment | Identity columns frozen by trigger | Yes |
| Wrong external company | A connection cannot reach `ACTIVE` without a confirmed company; provider and college are immutable | Yes |
| Pruning the journal | DELETE refused | Yes |
| Concurrent sync | Bounded worker, 25 per invocation, driven by row status | Partial — single-process only |

### There are no inbound webhooks

Phase 14 asks about signature verification and replay on **webhook**
requests. This integration has none: `app/api/cron/finance-sync/route.ts` is
a **QStash-triggered poller** that drains a PostgreSQL queue. It verifies the
QStash signature and returns **503 when signing keys are absent**, rather than
running unauthenticated.

So "validate the integration connection itself, do not trust `collegeId` in
the body" is satisfied trivially — there is no body. The worker reads the
connection from the database and derives tenancy from it.

---

## 7. Rule 8 — provenance retained — HOLDS

No external record is written into a generic table without its origin. The
hub does not write into `fees` or `payments` at all: a dedicated test
(*"the hub cannot move money"*) asserts that a full journal + link +
reconciliation cycle leaves the ledger byte-identical.

---

## 8. Not tested

- **No live provider call has ever been made.** No Tally instance, no BUSY
  instance, no Zoho organisation was contacted. Everything above is the
  database and the adapters' unit behaviour.
- The BUSY adapter reports every capability as `REQUIRES_CONFIGURATION` or
  `UNSUPPORTED` and fails `testConnection` with an explanation. That is
  deliberate honesty in the adapter, not a defect — but it does mean **BUSY
  is not a working integration today**.
- Concurrent sync across two worker processes: **NOT TESTED**. Real
  PostgreSQL is available here and used by the other concurrency suites, but
  no test drives two finance workers at one queue.
