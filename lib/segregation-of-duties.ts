import type { AuthorizedActor } from "@/lib/rbac";

/**
 * Separation of duties: the person who raised a request may not be the
 * person who decides it.
 *
 * This is a different question from the ownership checks already spread
 * through the app, and the codebase previously only answered the other one.
 * Every existing identity check points outward — "you may act only on the
 * flag assigned to you" (director/attention), "only on a course you
 * instruct" (teacher/grading, teacher/attendance), "only on your own
 * department's requests" (hod/approvals). Those all establish that you have
 * standing. None of them establish that you are not approving yourself.
 *
 * Before this helper the only separation-of-duties guard in the entire
 * application was admin/users' "you can't suspend your own account".
 *
 * The concrete case this closes: lib/invitations.ts sets profiles.department_id
 * on an invitee, so a Director inviting a HOD leaves that HOD carrying their
 * own department's id. listHodApprovals selects every staff profile with that
 * department_id — which includes the HOD themselves — and actOnLeaveRequestCore
 * then verified department ownership without ever comparing requested_by to
 * the actor. The HOD cannot submit through the UI (applyForLeave is
 * teacher/admin only), but leave_requests_insert_self is
 * `WITH CHECK (requested_by = auth.uid())`, so any authenticated user can
 * insert one directly with the anon key. Self-submit, then self-approve.
 *
 * `admin` is deliberately NOT exempt. An admin approving their own request is
 * exactly the case an auditor asks about, and this codebase's "admin
 * co-manages every domain module" convention is what makes it reachable.
 * Where a genuine break-glass path is needed it should be an explicit,
 * audit-logged action — not a silent exemption buried in a helper.
 */
export function assertNotSelfApproval(
  actor: AuthorizedActor,
  requesterId: string | null | undefined,
  entityLabel: string
): void {
  if (requesterId && requesterId === actor.userId) {
    throw new Error(
      `You can't act on your own ${entityLabel}. Ask another approver to review it.`
    );
  }
}
