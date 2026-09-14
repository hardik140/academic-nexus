
import { dbError } from "@/lib/internal-error";
/**
 * Guard for the read-check-write race every approval workflow in this app
 * shares.
 *
 * The shape throughout `app/(portal)/**\/actions.ts` is:
 *
 *   1. `select status` for the record
 *   2. `if (status !== 'pending') throw`
 *   3. `update({ status: action, ... }).eq("id", id)`
 *
 * Steps 1 and 3 are separate round trips, so two approvers clicking at the
 * same moment both pass step 2 and both write — last writer wins on
 * `approved_by`/`reviewed_by`, and any downstream side effect (substitution
 * rows, notifications, ledger writes) runs twice.
 *
 * The fix is to make step 3 re-assert the precondition itself, by adding the
 * status to the update's own predicate. That turns the write into an atomic
 * compare-and-swap: exactly one of the two racing updates matches a row.
 *
 * The catch — and the reason this helper exists rather than a bare `.eq()` —
 * is that Supabase reports "matched zero rows" as *success with no error*
 * (the same silent-no-op behaviour that produced migrations 010/012/013/038;
 * see their headers). So the losing writer looks like it worked. Pairing the
 * predicate with `.select("id")` and passing the result here is what makes
 * losing the race visible instead of silent.
 *
 * Usage — add the status predicate and `.select("id")`, then assert:
 *
 *   const { data: claimed, error } = await supabase
 *     .from("leave_requests")
 *     .update({ status: action, approved_by: actor.userId })
 *     .eq("id", requestId)
 *     .eq("college_id", actor.collegeId)
 *     .eq("status", "pending")
 *     .select("id");
 *   if (error) throw dbError(error);
 *   assertClaimed(claimed, "leave request");
 *
 * This is deliberately app-layer optimistic locking, not a transaction — it
 * makes the *status* transition safe on its own. Workflows that write several
 * tables together (refund approval, room transfer) still need a real
 * transaction for full atomicity; that's a separate, larger change.
 */
export function assertClaimed(rows: unknown[] | null, entityLabel: string): void {
  if (!rows || rows.length === 0) {
    throw new Error(
      `This ${entityLabel} was already actioned by someone else. Reload to see the current state.`
    );
  }
}

/**
 * The bulk-write counterpart: confirm a write actually persisted the rows it
 * was asked to, and return the MEASURED count.
 *
 * Same root cause as assertClaimed, different shape. A write whose rows are
 * filtered out by RLS comes back as success with fewer rows than were sent —
 * so `return { saved: rows.length }` reports what the caller *asked for*,
 * never what the database *did*. A teacher could be told "42 saved" with an
 * empty register behind it, which is worse than an error: it is a false
 * receipt for a legally significant record.
 *
 * The counts can only be compared when the write asks for its rows back:
 *
 *   const { data: persisted, error } = await supabase
 *     .from("attendance")
 *     .upsert(rows, { onConflict: "offering_id,student_id,date" })
 *     .select("id");
 *   if (error) throw dbError(error);
 *   return { saved: assertPersisted(persisted, rows.length, "attendance record") };
 *
 * ATOMIC, not partial — deliberately. These upserts are already all-or-
 * nothing upstream (verifyStudentsEnrolled rejects the whole request if any
 * one student is not enrolled in the offering), so a short write means
 * something is wrong with the request, not that most of it was fine. A
 * partial-success contract would also have to be expressed per record all
 * the way out to the mobile client, which is a bigger change than the defect
 * warrants. Callers with genuinely idempotent writes must NOT use this: see
 * createSubstitutionNeeds, where ignoreDuplicates makes zero rows the
 * expected result of a correct re-run.
 *
 * Zero requested is not an error. A caller with nothing to write gets zero
 * back, which is why `expected` is compared rather than merely tested for
 * emptiness.
 */
export function assertPersisted(
  rows: unknown[] | null,
  expected: number,
  entityLabel: string
): number {
  const persisted = rows?.length ?? 0;
  if (persisted === expected) return persisted;

  if (persisted === 0) {
    throw new Error(
      `No ${entityLabel} rows were saved — the database accepted the request but ` +
        `changed nothing, which usually means the write was refused. Nothing has ` +
        `been recorded; do not treat this as saved.`
    );
  }

  throw new Error(
    `Only ${persisted} of ${expected} ${entityLabel} rows were saved. The write was ` +
      `partially refused, so the records are now inconsistent with what was ` +
      `submitted. Reload before retrying.`
  );
}
