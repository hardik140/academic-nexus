"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { callRpc } from "@/lib/gate-security/rpc";
import { buildPayload, credentialSigningConfigured } from "@/lib/gate-security/credential";
import { qrSvg } from "@/lib/gate-security/qr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const ApplyForGatePassSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  exitTime: z.string().min(1),
  returnTime: z.string().min(1),
});

export interface ApplyForGatePassParams {
  destination: string;
  reason: string;
  exitTime: string;
  returnTime: string;
}

/**
 * Shared by the web Server Action below and app/api/mobile/gatepass/apply's
 * Route Handler — same guarded logic either way, just a different transport
 * (Server Action RPC for web, HTTP for the RN app).
 */
export async function applyForGatePassCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: ApplyForGatePassParams
) {
  const { destination, reason, exitTime, returnTime } = ApplyForGatePassSchema.parse(params);
  await checkRateLimit(`applyForGatePass:${actor.userId}`, 5, 60);

  const { data: student } = await supabase
    .from("students")
    .select("id")
    .eq("user_id", actor.userId)
    .single();

  if (!student) {
    throw new Error("No student record found for this account.");
  }

  const { error } = await supabase.from("gate_passes").insert({
    college_id: actor.collegeId,
    student_id: student.id,
    destination,
    reason,
    exit_time: exitTime,
    return_time: returnTime,
    status: "pending",
  });

  if (error) {
    throw dbError(error);
  }
}

export async function applyForGatePass(params: ApplyForGatePassParams) {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  await applyForGatePassCore(supabase, actor, params);
  revalidatePath("/student/gatepass");
}

/** Called by app/api/mobile/gatepass/apply/route.ts. */
export async function applyForGatePassViaRequest(request: Request, params: ApplyForGatePassParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["student"]);
  await applyForGatePassCore(supabase, actor, params);
}

// ─────────────────────────────────────────────────────────────
// The QR credential (migration 050)
// ─────────────────────────────────────────────────────────────

export type CredentialView =
  | { state: "none"; reason: string }
  | { state: "not_configured"; reason: string }
  | {
      state: "issued";
      status: "ACTIVE" | "CONSUMED" | "REVOKED" | "EXPIRED" | "SUPERSEDED";
      usable: boolean;
      svg: string | null;
      validFrom: string;
      expiresAt: string;
      movementState: "NOT_EXITED" | "OUTSIDE" | "RETURNED";
      reason: string;
    };

type CredentialRow = {
  credential_id: string;
  nonce: string;
  status: "ACTIVE" | "CONSUMED" | "REVOKED" | "EXPIRED" | "SUPERSEDED";
  valid_from: string;
  expires_at: string;
  version: number;
  college_id: string;
  movement_state: "NOT_EXITED" | "OUTSIDE" | "RETURNED";
};

/**
 * The student's own QR, rendered on the server.
 *
 * Three things are deliberate here:
 *
 *   1. my_gate_pass_credential() is a SECURITY DEFINER function keyed on
 *      auth.uid(), not a table read. The student has NO policy on
 *      gate_pass_credentials, so a crafted PostgREST request cannot fetch
 *      someone else's credential and this action cannot be tricked into
 *      fetching one either — the function itself will only ever return a
 *      row whose student is the caller.
 *
 *   2. The payload is assembled and turned into an <svg> here. It is never
 *      sent to the browser as text, so it does not appear in the DOM, in a
 *      prop, or in the flight stream — only as the geometry of the image.
 *
 *   3. An unusable credential returns no image at all rather than a greyed
 *      one. A revoked pass that still renders a scannable square is a pass
 *      a student will present in good faith and be turned away on.
 */
export async function getGatePassCredential(passIdRaw: string): Promise<CredentialView> {
  const actor = await requireRole(["student"]);
  const passId = z.string().guid().parse(passIdRaw);
  await checkRateLimit(`gatePassCredential:${actor.userId}`, 60, 60);
  const supabase = await createClient();

  const rows = await callRpc<CredentialRow>(supabase, "my_gate_pass_credential", { p_gate_pass_id: passId });
  const row = rows[0];
  if (!row) {
    return { state: "none", reason: "No QR has been issued for this pass yet. It is issued when a warden approves it." };
  }

  if (!credentialSigningConfigured()) {
    return {
      state: "not_configured",
      reason: "QR credentials are not configured on this server. Ask the front desk to record your movement manually.",
    };
  }

  const now = Date.now();
  const withinWindow = now >= Date.parse(row.valid_from) && now <= Date.parse(row.expires_at);
  const usable = row.status === "ACTIVE" && withinWindow;

  const reason =
    row.status === "REVOKED"
      ? "This QR has been revoked and cannot be used."
      : row.status === "CONSUMED"
        ? "You have returned on this pass. The QR is closed."
        : row.status === "SUPERSEDED"
          ? "A newer QR has been issued for this pass."
          : row.status === "EXPIRED" || now > Date.parse(row.expires_at)
            ? "This gate pass is no longer valid."
            : now < Date.parse(row.valid_from)
              ? "This QR becomes valid shortly before your exit time."
              : "Show this at the gate.";

  return {
    state: "issued",
    status: row.status,
    usable,
    svg: usable
      ? await qrSvg(
          buildPayload({
            credentialId: row.credential_id,
            nonce: row.nonce,
            collegeId: row.college_id,
            gatePassId: passId,
          })
        )
      : null,
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
    movementState: row.movement_state,
    reason,
  };
}

/** The student's own crossings, for the movement panel on their pass. */
export async function getMyGatePassMovements(passIdRaw: string) {
  await requireRole(["student"]);
  const passId = z.string().guid().parse(passIdRaw);
  const supabase = await createClient();
  const { data, error: dataError } = await supabase
    .from("gate_movements")
    .select("id, movement_type, occurred_at, is_override")
    .eq("gate_pass_id", passId)
    .order("occurred_at", { ascending: true });
  assertRead(dataError);
  return data ?? [];
}
