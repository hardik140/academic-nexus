# Gate Security test report

Phases 24, 25, 26, 27, 48.

Gate Security is the most heavily tested subsystem in this repository, and it
is also the one with the largest untested gap. Both halves matter.

---

## 1. Lifecycle (Phase 24) — PASS, DATABASE TESTED

The whole journey runs against a real PostgreSQL carrying the actual
migration chain, as the actual roles:

```
student applies → warden approves → credential issued (HMAC-signed QR)
  → guard scans → OUT recorded → student outside
  → guard scans the same QR → IN recorded → credential closed
```

`tests/staging-gate-security.test.ts`, *"the whole journey, through the
database only"* — plus a student leaving by one gate and returning through
another.

Each crossing is verified for: **student, gate pass, college, credential,
gate, guard, server timestamp, movement state, direction, audit event** —
the nine facts Phase 24 asks to be demonstrated.

| Property | Evidence |
| --- | --- |
| Server clock stamped, client timestamp discarded | *"stamps the server clock and discards any timestamp it is handed"* |
| Exactly one OUT and one IN per pass | *"accepts exactly one OUT and one IN per pass"* |
| Ledger is append-only | *"cannot be updated or deleted by anyone, including the owner"* |
| Refusals are audited too, not only successes | *"records the refusals as well as the movements"* |

---

## 2. QR attacks (Phase 25) — PASS, DATABASE + AUTOMATED TESTED

| Attack | Result |
| --- | --- |
| Copied QR / screenshot / reused QR | One movement per direction; a second tap in the window replays the stored movement rather than recording a new one |
| Expired credential | Refused, marked expired |
| Presented before its window | Refused |
| Revoked credential | Refused; revoking does not undo the approval |
| Modified payload, flipped signature character | Does not verify |
| Signature lifted from another credential | Does not transfer |
| Same credential in another tenant | Does not verify |
| Signed with a different key | Does not verify |
| Fabricated / malformed payload | Rejected before any lookup |
| Wrong student's QR | The scan takes no student and no pass from the caller — there is nothing to tamper with |
| Another college's QR | Refused, and says nothing about why |
| Guessed credential id | Refused |
| Missing signature | Parses, then fails verification |

The signing key **fails closed when absent** and does not fall back to a
default; a key short enough to guess is refused.

One design detail worth stating: the QR payload carries **prefix, credential
id and signature only** — no student, no name, no enrollment number, no
destination. A photographed QR discloses nothing about its holder.

---

## 3. Concurrency (Phase 26) — PASS, real PostgreSQL

`tests/realpg-gate-security.test.ts` runs **12 simultaneous scans** of one
credential across 12 real psql sessions against PostgreSQL 18. Exactly one
state transition survives; the rest are answered as duplicates.

OUT+OUT, IN+IN, OUT+IN and IN+OUT are covered by the movement state machine's
own constraints (`tests/staging-gate-security.test.ts`, the ledger section).

---

## 4. Authority separation (Phase 27) — PASS, DATABASE TESTED

| Requirement | Result |
| --- | --- |
| Director authorizes guards, assigns gates, manages instructions | Yes |
| Director does **not** inherit scanner privileges | Yes — *"no other role can call the movement recorder at all"* |
| Guard cannot promote themselves | Yes — *"only director and admin manage the roster"* |
| Guard cannot reach Finance, fees, refunds, marks, user administration | Yes — *"a guard has no read path to students, profiles, gate passes or credentials"* |
| Revoking an assignment takes effect on the very next scan | Yes |
| Removing the `movement.record` permission stops scanning without touching the account | Yes |
| DEACTIVATED is terminal — a deactivated guard cannot be revived to try again | Yes |
| **The service-role key itself cannot record a movement** | Yes — verified read-only against hosted Supabase: returns *"cannot be recorded without an authenticated operator"* |

That last row is the strongest single result in this subsystem. The most
privileged credential in the deployment cannot forge a crossing.

---

## 5. What makes these PASSes load-bearing

`tests/staging-mutations-gate-security.test.ts` removes each control from a
scratch database and shows the attack then succeeds:

| Control removed | What becomes possible |
| --- | --- |
| Gate assignment check | A guard assigned to NORTH processes a pass at MAIN |
| Tenant check on the credential | The cross-college scan stops being a clean refusal |
| …together with the composite key | **The breach lands** — so the key is the thing actually holding |
| Guard ACTIVE requirement | A suspended guard records movements again |
| Duplicate-scan window | A double tap records an exit and an immediate return |
| Ledger append-only trigger | A recorded movement is edited into a different history |
| INSERT trigger only | A client-supplied timestamp reaches the ledger |
| Narrowed `gate_passes` policy | A warden writes a movement at a time of their choosing |
| Credential window check | A five-day-old pass opens a gate |
| Nonce column privilege | Every signed-in role reads the material the QR is signed over |
| Movement identity binding | A movement is attributed to the wrong student |

A test that passes when the control is removed proves nothing. These fail.

---

## 6. Phase 48 — REAL DEVICE: NOT TESTED

**No camera has ever been opened against this scanner. No phone has ever
displayed a QR to it. No physical crossing has ever been recorded.**

| Step | Status |
| --- | --- |
| Student phone displays QR | **NOT TESTED** |
| Guard device opens scanner, camera permission granted | **NOT TESTED** |
| QR recognized by `jsQR` from a live video frame | **NOT TESTED** |
| Server validates, OUT recorded | **NOT TESTED** |
| Same QR scanned on return, IN recorded | **NOT TESTED** |
| Poor lighting / low brightness | **NOT TESTED** |
| Slow network / temporary loss | **NOT TESTED** |
| Invalid, expired, duplicate QR on a real device | **NOT TESTED** |

What *is* known about the browser layer, from the previous audit:

- `Permissions-Policy: camera=(self)` is served on `/security/scanner` and
  `camera=()` everywhere else — **runtime-verified with `curl`**. Before that
  fix the camera was denied to every origin including this one, so the
  scanner could not have worked at all.
- Six defects in `scanner-client.tsx` were found and fixed by inspection:
  stale-closure double submission, no per-payload cooldown, camera not
  released on unmount or tab switch, no secure-context check, unmapped
  permission errors, no camera picker.

**None of that is a substitute for opening the camera once.** The honest
statement is: the database layer is thoroughly proven and the device layer
is entirely unproven.

---

## 7. Summary

| Phase | Status |
| --- | --- |
| 24 — lifecycle | **PASS — DATABASE TESTED** |
| 25 — QR attacks | **PASS — DATABASE + AUTOMATED TESTED** |
| 26 — concurrency | **PASS — real PostgreSQL, 12 sessions** |
| 27 — authority separation | **PASS — DATABASE TESTED** |
| 48 — real device | **NOT TESTED — REAL DEVICE REQUIRED** |
