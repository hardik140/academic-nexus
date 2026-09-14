"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { callRpc } from "@/lib/gate-security/rpc";
import {
  parsePayload,
  signatureMatches,
  payloadFingerprint,
  credentialSigningConfigured,
} from "@/lib/gate-security/credential";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * The Security Guard's whole server surface.
 *
 * Everything here is scanning and looking at the result of scanning. There
 * is no approval action, no student record, no fee, no mark — not because
 * the screens do not offer them but because this file does not contain
 * them, and this file is the only thing the guard's portal can call.
 */

/** What the scanner shows the guard. The database decides all of it. */
export interface ScanResult {
  outcome: string;
  movement: "OUT" | "IN" | null;
  gatePassId: string | null;
  passCode: string | null;
  studentName: string | null;
  enrollmentNumber: string | null;
  destination: string | null;
  purpose: string | null;
  expectedReturn: string | null;
  occurredAt: string | null;
  gateName: string | null;
  detail: string;
}

type MovementRow = {
  outcome: string;
  movement: "OUT" | "IN" | null;
  gate_pass_id: string | null;
  pass_code: string | null;
  student_name: string | null;
  enrollment_number: string | null;
  destination: string | null;
  purpose: string | null;
  expected_return: string | null;
  occurred_at: string | null;
  gate_name: string | null;
  detail: string;
};

/**
 * The single message the guard is shown for every refusal that means "this
 * is not a credential we will act on".
 *
 * Deliberately identical across "never existed", "signature does not
 * verify" and "belongs to another college". The audit row distinguishes
 * all three; the scanner does not, because a scanner that answers
 * differently is an oracle — it tells someone probing with generated QRs
 * which of their guesses named a real credential.
 */
const OPAQUE_INVALID: ScanResult = {
  outcome: "INVALID_QR",
  movement: null,
  gatePassId: null,
  passCode: null,
  studentName: null,
  enrollmentNumber: null,
  destination: null,
  purpose: null,
  expectedReturn: null,
  occurredAt: null,
  gateName: null,
  detail: "The QR credential could not be verified.",
};

const ScanSchema = z.object({
  payload: z.string().min(1).max(200),
  gateId: z.string().guid(),
  device: z
    .object({
      userAgent: z.string().max(300).optional(),
      source: z.enum(["camera", "manual", "api"]).optional(),
    })
    .optional(),
});

export interface ScanParams {
  payload: string;
  gateId: string;
  device?: { userAgent?: string; source?: "camera" | "manual" | "api" };
}

/**
 * Scan a QR and record the resulting movement.
 *
 * The order below is the security argument, so it is worth reading as one:
 *
 *   requireRole        the caller holds the gate_security ROLE
 *   rate limit         a stolen session cannot enumerate credentials
 *   parsePayload       the string is one of ours, structurally
 *   service-role read  fetch the nonce — the ONLY read of that column in
 *                      the application, and the reason it is a service-role
 *                      client is that `authenticated` has no column
 *                      privilege on it under any role, including this one
 *   signatureMatches   constant-time, against this installation's key
 *   RPC                everything that actually authorises: the guard's
 *                      status and permissions, the gate assignment, the
 *                      credential's state and window, the pass's state, the
 *                      direction, the ledger row, the timestamp
 *
 * The RPC runs on the GUARD's client, not the service-role one. That
 * matters: record_gate_movement() reads auth.uid() to decide who is
 * scanning, and handing it a service-role session would hand it a NULL
 * actor and no personnel row.
 */
export async function scanGatePassCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: ScanParams
): Promise<ScanResult> {
  const { payload, gateId, device } = ScanSchema.parse(params);
  await checkRateLimit(`gateScan:${actor.userId}`, 120, 60);

  if (!credentialSigningConfigured()) {
    // Fail closed and say so plainly: this is an operational fault, not a
    // bad pass, and a guard who is told "invalid" would wave the student
    // through or turn them away for the wrong reason.
    throw new Error(
      "Gate pass scanning is not configured on this server. Contact the administrator before admitting anyone on a QR."
    );
  }

  const fingerprint = payloadFingerprint(payload);
  const audit = async (action: string, meta: Record<string, unknown>) => {
    await logAudit(supabase, actor, action, "gate_movements", gateId, {
      newValue: { fingerprint, gate_id: gateId, ...meta },
    });
  };

  const parsed = parsePayload(payload);
  if (!parsed) {
    await audit("gate_scan_unparseable", { reason: "not an Academic Nexus gate credential" });
    return OPAQUE_INVALID;
  }

  const credential = await loadCredentialForVerification(parsed.credentialId);
  if (!credential) {
    await audit("gate_scan_unknown_credential", { credential_id: parsed.credentialId });
    return OPAQUE_INVALID;
  }

  const signed = signatureMatches(
    {
      credentialId: credential.id,
      nonce: credential.nonce,
      collegeId: credential.college_id,
      gatePassId: credential.gate_pass_id,
    },
    parsed.signature
  );

  if (!signed) {
    await audit("gate_scan_bad_signature", { credential_id: parsed.credentialId });
    return OPAQUE_INVALID;
  }

  const rows = await callRpc<MovementRow>(supabase, "record_gate_movement", {
    p_credential_id: credential.id,
    p_gate_id: gateId,
    p_device: { ...(device ?? {}), fingerprint },
  });

  const row = rows[0];
  if (!row) {
    await audit("gate_scan_no_result", { credential_id: parsed.credentialId });
    return { ...OPAQUE_INVALID, detail: "The scan could not be completed. Try again." };
  }

  return {
    outcome: row.outcome,
    movement: row.movement,
    gatePassId: row.gate_pass_id,
    passCode: row.pass_code,
    studentName: row.student_name,
    enrollmentNumber: row.enrollment_number,
    destination: row.destination,
    purpose: row.purpose,
    expectedReturn: row.expected_return,
    occurredAt: row.occurred_at,
    gateName: row.gate_name,
    detail: row.detail,
  };
}

interface VerifiableCredential {
  id: string;
  nonce: string;
  college_id: string;
  gate_pass_id: string;
}

/**
 * The nonce read, isolated so it is greppable and so the column name
 * appears exactly twice in the whole application — here and in the
 * credential issuer inside migration 050.
 *
 * Service-role, and it has to be: `authenticated` holds no column privilege
 * on `nonce` under ANY role, this one included, so the guard's own session
 * cannot make this read however the policies are written. `nonce` is
 * likewise absent from the Database type (see the comment on
 * gate_pass_credentials there), which is why this steps outside it — the
 * same locally-declared escape hatch lib/finance/credentials.ts uses for
 * its ciphertext table.
 *
 * The row is used to verify a signature and then discarded. It is never
 * returned to a caller and never written to a log.
 */
async function loadCredentialForVerification(credentialId: string): Promise<VerifiableCredential | null> {
  const client = createAdminClient() as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => {
          maybeSingle: () => PromiseLike<{ data: VerifiableCredential | null }>;
        };
      };
    };
  };
  const { data } = await client
    .from("gate_pass_credentials")
    .select("id, nonce, college_id, gate_pass_id")
    .eq("id", credentialId)
    .maybeSingle();
  return data ?? null;
}

export async function scanGatePass(params: ScanParams): Promise<ScanResult> {
  const actor = await requireRole(PERMISSIONS.gate_security_scan);
  const supabase = await createClient();
  return scanGatePassCore(supabase, actor, params);
}

/** Called by app/api/security/scan/route.ts. */
export async function scanGatePassViaRequest(request: Request, params: ScanParams): Promise<ScanResult> {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.gate_security_scan);
  return scanGatePassCore(supabase, actor, params);
}

// ─────────────────────────────────────────────────────────────
// What the guard's screens read
// ─────────────────────────────────────────────────────────────

export interface SecurityContext {
  personnelId: string | null;
  status: string | null;
  employeeCode: string | null;
  permissions: string[];
  gates: { id: string; code: string; name: string }[];
  instructions: { id: string; title: string; message: string; priority: string; created_at: string }[];
}

/**
 * Who the guard is, which gates they may operate, and what they have been
 * told. Every screen in the portal starts here, and a guard whose personnel
 * row is missing or not ACTIVE gets a context with no gates — which is what
 * the scanner checks before it will render.
 */
export async function securityContext(): Promise<SecurityContext> {
  const actor = await requireRole(PERMISSIONS.gate_security_dashboard);
  const supabase = await createClient();

  const { data: person } = await supabase
    .from("security_personnel")
    .select("id, status, employee_code, permissions")
    .eq("profile_id", actor.userId)
    .maybeSingle();

  if (!person || person.status !== "ACTIVE") {
    return {
      personnelId: person?.id ?? null,
      status: person?.status ?? null,
      employeeCode: person?.employee_code ?? null,
      permissions: [],
      gates: [],
      instructions: [],
    };
  }

  const { data: assignments } = await supabase
    .from("security_gate_assignments")
    .select("gate_id")
    .eq("security_personnel_id", person.id)
    .is("revoked_at", null);

  const gateIds = (assignments ?? []).map((a) => a.gate_id);
  const { data: gates } = gateIds.length
    ? await supabase.from("gates").select("id, code, name").in("id", gateIds).eq("is_active", true).order("code")
    : { data: [] };

  const { data: instructions } = await supabase
    .from("security_instructions")
    .select("id, title, message, priority, created_at")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    personnelId: person.id,
    status: person.status,
    employeeCode: person.employee_code,
    permissions: person.permissions ?? [],
    gates: gates ?? [],
    instructions: instructions ?? [],
  };
}

export interface ScanFeedRow {
  movement_id: string;
  movement_type: "OUT" | "IN";
  occurred_at: string;
  student_name: string;
  enrollment_number: string;
  pass_code: string;
  destination: string;
  gate_name: string | null;
  is_override: boolean;
}

/** Recent scans at one of the caller's own gates. */
export async function securityScanFeed(gateId: string, limit = 20): Promise<ScanFeedRow[]> {
  const actor = await requireRole(PERMISSIONS.gate_security_history);
  const supabase = await createClient();
  z.string().guid().parse(gateId);
  await checkRateLimit(`gateFeed:${actor.userId}`, 120, 60);
  return callRpc<ScanFeedRow>(supabase, "security_scan_feed", { p_gate_id: gateId, p_limit: limit });
}

export interface OutsideRow {
  gate_pass_id: string;
  pass_code: string;
  student_name: string;
  enrollment_number: string;
  destination: string;
  exited_at: string | null;
  due_back: string;
  overdue: boolean;
}

/** Who is outside right now, across the college. */
export async function securityOutsideNow(): Promise<OutsideRow[]> {
  await requireRole(PERMISSIONS.gate_security_dashboard);
  const supabase = await createClient();
  return callRpc<OutsideRow>(supabase, "security_outside_now", {});
}

/** Today's movement counts at a gate — read straight off the ledger. */
export async function securityTodayCounts(gateId: string): Promise<{ out: number; in: number }> {
  await requireRole(PERMISSIONS.gate_security_dashboard);
  const supabase = await createClient();
  z.string().guid().parse(gateId);

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("gate_movements")
    .select("movement_type")
    .eq("gate_id", gateId)
    .gte("occurred_at", since.toISOString());

  const rows = data ?? [];
  return {
    out: rows.filter((r) => r.movement_type === "OUT").length,
    in: rows.filter((r) => r.movement_type === "IN").length,
  };
}
