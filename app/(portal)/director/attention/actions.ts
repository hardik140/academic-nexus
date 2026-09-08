"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

function attentionCacheKey(scopeKey: string) {
  return `attention:${scopeKey}`;
}

/** Resolves the department a HOD actor owns, via departments.hod_id — same as hod/approvals. */
async function resolveHodDepartmentId(supabase: SupabaseClient<Database>, actor: AuthorizedActor) {
  const { data } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
  return data?.id ?? null;
}

/**
 * Director: institution-wide. HOD: scoped to their own department
 * (department_risk_read is ["director","hod"] — this is the app-layer
 * narrowing block for the hod branch, RLS only enforces role+tenancy).
 */
export async function listRiskFlags() {
  const actor = await requireRole(PERMISSIONS.department_risk_read);
  const supabase = await createClient();

  let departmentId: string | null = null;
  if (actor.role === "hod") {
    departmentId = await resolveHodDepartmentId(supabase, actor);
  }

  const cacheKey = attentionCacheKey(actor.role === "hod" ? `hod:${actor.userId}` : `director:${actor.collegeId}`);

  return getCached(cacheKey, 30, async () => {
    const baseQuery = () => {
      let q = supabase
        .from("risk_flags")
        .select("*, department:department_id(name, code), assignee:assigned_to(full_name, role)")
        .eq("college_id", actor.collegeId);
      if (departmentId) q = q.eq("department_id", departmentId);
      return q;
    };

    const [openRes, resolvedRes] = await Promise.all([
      baseQuery().in("status", ["open", "assigned", "acknowledged", "in_progress"]).order("severity", { ascending: false }).order("detected_at", { ascending: false }),
      baseQuery().in("status", ["resolved", "dismissed"]).order("resolved_at", { ascending: false }).limit(30),
    ]);
    return { open: openRes.data || [], resolved: resolvedRes.data || [] };
  });
}

/** For a HOD/Warden/Placement Cell/Teacher dashboard's "Director Escalations" section. */
export async function listMyRiskFlagAssignments() {
  const actor = await requireRole(PERMISSIONS.escalation_acknowledge);
  const supabase = await createClient();

  return getCached(attentionCacheKey(`assigned:${actor.userId}`), 30, async () => {
    const { data } = await supabase
      .from("risk_flags")
      .select("*, department:department_id(name, code)")
      .eq("assigned_to", actor.userId)
      .in("status", ["assigned", "acknowledged", "in_progress"])
      .order("severity", { ascending: false })
      .order("assigned_at", { ascending: false });
    return data || [];
  });
}

export async function getRiskFlag(flagId: string) {
  const actor = await requireRole(PERMISSIONS.department_risk_read);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("risk_flags")
    .select(
      "*, department:department_id(name, code), assignee:assigned_to(full_name, role), assigner:assigned_by(full_name), reviewer:reviewed_by(full_name)"
    )
    .eq("id", flagId)
    .eq("college_id", actor.collegeId)
    .single();
  if (error || !data) {
    throw new Error("Risk flag not found.");
  }
  return data;
}

/**
 * Live-computed, aggregate-first student risk overview — per department:
 * how many active students have at least one real risk factor (low CGPA,
 * an overdue fee, or a failed/backlog course enrollment), and how many have
 * two or more simultaneously ("critical"). No persistence, no invented
 * score — every count traces to a real row. HOD callers are narrowed to
 * their own department, same as listRiskFlags.
 */
export async function getStudentRiskOverview() {
  const actor = await requireRole(PERMISSIONS.department_risk_read);
  const supabase = await createClient();

  let departmentId: string | null = null;
  if (actor.role === "hod") {
    departmentId = await resolveHodDepartmentId(supabase, actor);
  }

  const cacheKey = attentionCacheKey(
    `student-risk:${actor.role === "hod" ? `hod:${actor.userId}` : `director:${actor.collegeId}`}`
  );

  return getCached(cacheKey, 120, async () => {
    let studentsQuery = supabase
      .from("students")
      .select("id, user_id, department_id, cgpa, departments:department_id(name, code)")
      .eq("college_id", actor.collegeId)
      .eq("status", "active");
    if (departmentId) studentsQuery = studentsQuery.eq("department_id", departmentId);

    const [studentsRes, feesRes, enrollRes] = await Promise.all([
      studentsQuery,
      // No status filter here — nothing anywhere ever sets fees.status =
      // 'overdue' (no cron, no trigger), so that raw filter always read
      // zero. Overdue is computed live below via computeEffectiveFeeStatus.
      // See lib/finance-status.ts.
      supabase.from("fees").select("student_id, status, due_date, amount, paid_amount").eq("college_id", actor.collegeId),
      supabase.from("course_enrollments").select("student_id").eq("college_id", actor.collegeId).eq("status", "failed"),
    ]);

    // Cast to any: this hand-maintained types file doesn't declare table
    // Relationships, so the embedded departments:department_id(...) join
    // can't be inferred — same pattern used throughout the rest of the app
    // (e.g. hod/approvals/actions.ts).
    const students = (studentsRes.data || []) as any[];
    const userIdToStudentId = new Map(students.map((s) => [s.user_id, s.id]));
    const overdueFeeStudentIds = new Set(
      (feesRes.data || []).filter((f) => computeEffectiveFeeStatus(f) === "overdue").map((f) => f.student_id)
    );
    const backlogStudentIds = new Set(
      (enrollRes.data || [])
        .map((e) => userIdToStudentId.get(e.student_id))
        .filter((id): id is string => !!id)
    );

    const byDepartment = new Map<
      string,
      { name: string; code: string; totalStudents: number; atRisk: number; critical: number }
    >();

    for (const s of students) {
      const dept = (s as any).departments;
      const key = s.department_id;
      if (!byDepartment.has(key)) {
        byDepartment.set(key, { name: dept?.name || "Unknown", code: dept?.code || "", totalStudents: 0, atRisk: 0, critical: 0 });
      }
      const entry = byDepartment.get(key)!;
      entry.totalStudents++;

      let factors = 0;
      if (s.cgpa != null && s.cgpa < 5) factors++;
      if (overdueFeeStudentIds.has(s.id)) factors++;
      if (backlogStudentIds.has(s.id)) factors++;

      if (factors >= 1) entry.atRisk++;
      if (factors >= 2) entry.critical++;
    }

    return Array.from(byDepartment.entries()).map(([departmentId, v]) => ({ departmentId, ...v }));
  });
}

const ManualFlagSchema = z.object({
  flagType: z.enum([
    "attendance_decline",
    "academic_backlog",
    "fee_overdue",
    "placement_inactivity",
    "hostel_issue",
    "faculty_workload_gap",
    "composite_student_risk",
    "institutional_metric",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  scopeLevel: z.enum(["institution", "department", "student", "faculty", "hostel_block"]),
  departmentId: z.string().guid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
});
export type ManualFlagParams = z.infer<typeof ManualFlagSchema>;

export async function createManualRiskFlag(params: ManualFlagParams) {
  const actor = await requireRole(PERMISSIONS.risk_flag_create);
  await checkRateLimit(`createManualRiskFlag:${actor.userId}`, 20, 3600);
  const parsed = ManualFlagSchema.parse(params);
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("risk_flags")
    .insert({
      college_id: actor.collegeId,
      flag_type: parsed.flagType,
      severity: parsed.severity,
      scope_level: parsed.scopeLevel,
      department_id: parsed.departmentId ?? null,
      title: parsed.title,
      description: parsed.description,
      source: "director_manual",
      status: "open",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create risk flag.");
  }

  await logAudit(supabase, actor, "risk_flag_created", "risk_flags", data.id, {
    newValue: { status: "open", flag_type: parsed.flagType, severity: parsed.severity },
  });

  await invalidateCache(attentionCacheKey(`director:${actor.collegeId}`));
  revalidatePath("/director/attention");
  return { id: data.id as string };
}

const AssignSchema = z.object({
  flagId: z.string().guid(),
  assigneeId: z.string().guid(),
});

const ASSIGNMENT_MESSAGE: Record<string, string> = {
  attendance_decline: "Attendance in your department has dropped below target — action required.",
  academic_backlog: "Backlog rate in your department is elevated — action required.",
  fee_overdue: "Fee collection in your department is behind target — action required.",
  placement_inactivity: "Placement activity in your department is below target — action required.",
  hostel_issue: "Hostel occupancy/incident threshold reached — action required.",
  faculty_workload_gap: "A faculty workload gap was flagged — action required.",
  composite_student_risk: "A student risk pattern was flagged — action required.",
  institutional_metric: "An institutional metric requires attention.",
};

export async function assignRiskFlag(params: { flagId: string; assigneeId: string }) {
  const actor = await requireRole(PERMISSIONS.risk_flag_assign);
  const { flagId, assigneeId } = AssignSchema.parse(params);
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("risk_flags")
    .select("status, title, flag_type")
    .eq("id", flagId)
    .eq("college_id", actor.collegeId)
    .single();
  if (!existing) {
    throw new Error("Risk flag not found.");
  }

  const { error } = await supabase
    .from("risk_flags")
    .update({ assigned_to: assigneeId, assigned_by: actor.userId, assigned_at: new Date().toISOString(), status: "assigned" })
    .eq("id", flagId)
    .eq("college_id", actor.collegeId);
  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, "risk_flag_assigned", "risk_flags", flagId, {
    oldValue: { status: existing.status },
    newValue: { status: "assigned", assigned_to: assigneeId },
  });

  await supabase.from("notifications").insert({
    college_id: actor.collegeId,
    title: "New escalation assigned to you",
    message: `${existing.title} — ${ASSIGNMENT_MESSAGE[existing.flag_type] || "Action required."}`,
    receiver_id: assigneeId,
    sender_id: actor.userId,
    type: "action_required",
    link: `/director/attention/${flagId}`,
  });

  await invalidateCache(attentionCacheKey(`director:${actor.collegeId}`));
  revalidatePath("/director/attention");
  revalidatePath(`/director/attention/${flagId}`);
}

const ActOnFlagSchema = z.object({
  flagId: z.string().guid(),
  action: z.enum(["acknowledge", "start", "resolve"]),
  resolutionNotes: z.string().trim().max(2000).optional(),
});

/**
 * Shared by HOD/Warden/Placement Cell/Teacher dashboards. Row-level RLS
 * (risk_flags_update) already restricts this to director OR
 * assigned_to = auth.uid() — this app-layer check additionally verifies
 * the CALLER is the actual assignee (not just any member of an allowed
 * role), same "RLS = role+tenancy, action = fine-grained scope" split used
 * throughout this codebase.
 */
export async function actOnRiskFlag(params: { flagId: string; action: "acknowledge" | "start" | "resolve"; resolutionNotes?: string }) {
  const actor = await requireRole(PERMISSIONS.escalation_act);
  const { flagId, action, resolutionNotes } = ActOnFlagSchema.parse(params);
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("risk_flags")
    .select("status, assigned_to, title")
    .eq("id", flagId)
    .eq("college_id", actor.collegeId)
    .single();
  if (!existing) {
    throw new Error("Risk flag not found.");
  }
  if (existing.status === "resolved" || existing.status === "dismissed") {
    throw new Error("This escalation has already been finalized.");
  }
  if (existing.assigned_to !== actor.userId) {
    throw new Error("This escalation is not assigned to you.");
  }

  const statusMap = { acknowledge: "acknowledged", start: "in_progress", resolve: "resolved" } as const;
  const newStatus = statusMap[action];

  const update: Database["public"]["Tables"]["risk_flags"]["Update"] = { status: newStatus };
  if (action === "acknowledge") update.acknowledged_at = new Date().toISOString();
  if (action === "resolve") {
    update.resolved_at = new Date().toISOString();
    update.resolution_notes = resolutionNotes ?? null;
  }

  const { error } = await supabase.from("risk_flags").update(update).eq("id", flagId).eq("college_id", actor.collegeId);
  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `risk_flag_${newStatus}`, "risk_flags", flagId, {
    oldValue: { status: existing.status },
    newValue: { status: newStatus, resolution_notes: resolutionNotes ?? null },
  });

  if (action === "resolve") {
    const { data: directors } = await supabase.from("profiles").select("id").eq("college_id", actor.collegeId).eq("role", "director");
    if (directors && directors.length > 0) {
      await supabase.from("notifications").insert(
        directors.map((d) => ({
          college_id: actor.collegeId,
          title: "Escalation marked resolved",
          message: `"${existing.title}" was marked resolved — review needed.`,
          receiver_id: d.id,
          sender_id: actor.userId,
          type: "info" as const,
          link: `/director/attention/${flagId}`,
        }))
      );
    }
  }

  await invalidateCache(attentionCacheKey(`assigned:${actor.userId}`));
  await invalidateCache(attentionCacheKey(`director:${actor.collegeId}`));
  revalidatePath("/director/attention");
  revalidatePath(`/director/attention/${flagId}`);
}

const ReviewSchema = z.object({
  flagId: z.string().guid(),
  outcome: z.enum(["accept", "reopen"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function reviewRiskFlag(params: { flagId: string; outcome: "accept" | "reopen"; reason?: string }) {
  const actor = await requireRole(PERMISSIONS.risk_flag_review);
  const { flagId, outcome, reason } = ReviewSchema.parse(params);
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("risk_flags")
    .select("status, assigned_to, title")
    .eq("id", flagId)
    .eq("college_id", actor.collegeId)
    .single();
  if (!existing) {
    throw new Error("Risk flag not found.");
  }

  const update: Database["public"]["Tables"]["risk_flags"]["Update"] = {
    reviewed_by: actor.userId,
    reviewed_at: new Date().toISOString(),
  };
  if (outcome === "reopen") {
    update.status = "in_progress";
  }

  const { error } = await supabase.from("risk_flags").update(update).eq("id", flagId).eq("college_id", actor.collegeId);
  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `risk_flag_review_${outcome}`, "risk_flags", flagId, {
    oldValue: { status: existing.status },
    newValue: { status: update.status ?? existing.status, reviewed_by: actor.userId },
  });

  if (existing.assigned_to) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: outcome === "accept" ? "Resolution accepted" : "Escalation reopened",
      message:
        outcome === "accept"
          ? `Director accepted your resolution for "${existing.title}".`
          : `Director reopened "${existing.title}".${reason ? ` ${reason}` : ""}`,
      receiver_id: existing.assigned_to,
      sender_id: actor.userId,
      type: outcome === "accept" ? "success" : "action_required",
      link: `/director/attention/${flagId}`,
    });
  }

  await invalidateCache(attentionCacheKey(`director:${actor.collegeId}`));
  revalidatePath("/director/attention");
  revalidatePath(`/director/attention/${flagId}`);
}

/** Populates the "Assign to" select on the Attention detail page. */
export async function listAssignableStaff() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("college_id", actor.collegeId)
    .in("role", ["hod", "warden", "placement_cell", "finance", "admin"])
    .order("full_name");
  if (error) {
    throw new Error(error.message);
  }
  return data || [];
}
