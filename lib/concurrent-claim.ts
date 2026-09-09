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
 *   if (error) throw new Error(error.message);
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
