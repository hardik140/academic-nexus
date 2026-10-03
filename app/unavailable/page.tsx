import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  AccessFeatureUnavailable,
  listOwnSessions,
  readAccessState,
  type AccessState,
  type OwnSession,
} from "@/lib/college-access";
import type { UnavailableReason } from "@/components/portal/unavailable-view";
import { UnavailableClient } from "./unavailable-client";

export const metadata: Metadata = { title: "Unavailable — Academic Nexus" };

const QUERY_REASONS: UnavailableReason[] = ["maintenance", "suspended", "session_limit", "session_revoked", "inactive", "error"];

/**
 * Where middleware sends a session it refused (migrations 053/054).
 *
 * The reason shown comes from the DATABASE (my_access_state), not from the
 * query string — the query only names the fallback when the state cannot be
 * read. A caller who is in fact allowed is sent on to their dashboard.
 */
export default async function UnavailablePage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const query = (await searchParams).reason;
  const fallback: UnavailableReason = QUERY_REASONS.includes(query as UnavailableReason) ? (query as UnavailableReason) : "error";

  let state: AccessState | null = null;
  try {
    state = await readAccessState(supabase);
  } catch (err) {
    if (err instanceof AccessFeatureUnavailable) redirect("/");
  }

  const reason = state ? reasonFor(state) : fallback;
  if (reason === null) redirect("/");

  let sessions: OwnSession[] = [];
  if (reason === "session_limit") {
    try {
      sessions = await listOwnSessions(supabase);
    } catch {
      sessions = [];
    }
  }

  return (
    <UnavailableClient
      reason={reason}
      collegeName={state?.college_name ?? null}
      message={state?.message ?? null}
      expectedResumeAt={state?.expected_resume_at ?? null}
      sessions={sessions}
      maxSessions={state?.max_sessions ?? null}
    />
  );
}

/** The reason the database gives, or null when nothing blocks the caller. */
function reasonFor(state: AccessState): UnavailableReason | null {
  if (state.allowed) return null;
  if (state.profile_status !== "active") return "inactive";
  if (state.role !== "super_admin" && state.college_state === "MAINTENANCE") return "maintenance";
  if (state.role !== "super_admin" && state.college_state === "SUSPENDED") return "suspended";
  if (state.session_state === "rejected") return "session_limit";
  return "session_revoked";
}
