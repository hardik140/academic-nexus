"use client";

import { RequestDecision } from "@/components/portal/request-decision";
import { submitDecision } from "@/app/(portal)/director/decisions/actions";

/**
 * Shared by HOD, Warden, and Placement Cell dashboards — the only entry
 * point into the Decision Inbox (decisions_submit RLS restricts insert to
 * exactly these three roles, see migration 026). Calls the same
 * submitDecision Server Action Director's own Decision Inbox reads from.
 * The form and its feedback: components/portal/request-decision.tsx.
 */
export function RequestDecisionButton() {
  return <RequestDecision onSubmit={submitDecision} />;
}
