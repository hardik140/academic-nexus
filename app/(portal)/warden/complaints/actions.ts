"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const COMPLAINTS_PAGE_SIZE = 10;
const COMPLAINTS_SORT_COLUMNS = ["title"] as const;
const COMPLAINTS_CACHE_PREFIX = "list:hostel-complaints";
const HOSTEL_CATEGORIES = ["hostel", "mess", "plumbing", "electrical", "ac_hvac", "carpentry", "cleaning", "safety"] as const;

/**
 * Whether a complaint's submitter is in this warden's block scope: their
 * student record has an ACTIVE allocation in one of the warden's rooms.
 *
 * One record, two bounded reads. hostel_allocations is already scoped to
 * the warden's own rooms by RLS (hostel_allocations_staff_manage, 047), so
 * "an active allocation is visible" is exactly "allocated in my block".
 * This replaced membership in an id list of the whole block, which
 * PostgREST capped at 1,000 rows: in a larger block a warden was refused on
 * a complaint that was theirs to handle.
 *
 * complaints.submitted_by references profiles(id), allocations students(id),
 * hence the hop through students.user_id.
 */
async function wardenScopesSubmitter(supabase: SupabaseClient<Database>, submittedBy: string): Promise<boolean> {
  const { data: student, error: studentError } = await supabase.from("students").select("id").eq("user_id", submittedBy).maybeSingle();
  assertRead(studentError);
  if (!student) return false;
  const { count, error: allocationError } = await supabase
    .from("hostel_allocations")
    .select("id", { count: "exact", head: true })
    .eq("student_id", student.id)
    .eq("status", "active");
  assertRead(allocationError);
  return (count ?? 0) > 0;
}

/**
 * Block ownership was NOT enforced here until now — every other Warden
 * action file (gatepasses, transfers) resolves and filters by
 * hostel_blocks.warden_id; this one only checked role + college, so any
 * warden could see and act on every block's hostel complaints, not just
 * their own.
 */
export async function listHostelComplaints(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.hostel_complaint_manage);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(COMPLAINTS_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = versionedKey(
    listCacheKey(COMPLAINTS_CACHE_PREFIX, actor.role === "admin" ? actor.collegeId : actor.userId, q, column),
    COMPLAINTS_CACHE_PREFIX,
    actor.collegeId
  );

  return getCached(cacheKey, 30, async () => {
    // Block scope is PostgreSQL's (complaints_staff, migration 047: a warden
    // reads only complaints submitted by students allocated in their own
    // rooms; an admin, the college). The old app-side copy resolved the
    // block's students into id lists capped at PostgREST's 1,000 rows and
    // sent them back as a URL filter.
    let dbQuery = supabase
      .from("complaints")
      .select("*, profiles:submitted_by(full_name)", { count: "exact" })
      .in("category", HOSTEL_CATEGORIES);

    if (q.search) dbQuery = dbQuery.ilike("title", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * COMPLAINTS_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + COMPLAINTS_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const UpdateComplaintStatusSchema = z.object({
  complaintId: z.string().guid(),
  status: z.enum(["in_progress", "resolved"]),
});

/**
 * Shared by the web Server Action below and app/api/mobile/complaints/status's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function updateComplaintStatusCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  ({ complaintId, status } = UpdateComplaintStatusSchema.parse({ complaintId, status }));
  await checkRateLimit(`updateComplaintStatus:${actor.userId}`, 30, 60);

  const { data: existing } = await supabase
    .from("complaints")
    .select("status, submitted_by, title")
    .eq("id", complaintId)
    .eq("college_id", actor.collegeId)
    .single();
  if (!existing || (existing.status !== "open" && existing.status !== "in_progress")) {
    throw new Error("Complaint not found or already resolved.");
  }

  if (actor.role === "warden" && !(await wardenScopesSubmitter(supabase, existing.submitted_by))) {
    throw new Error("You can only act on complaints from students in your own hostel block(s).");
  }

  // Compare-and-swap on the exact status read above. See
  // lib/concurrent-claim.ts.
  const { data: claimed, error } = await supabase
    .from("complaints")
    .update({
      status,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
    })
    .eq("id", complaintId)
    .eq("college_id", actor.collegeId)
    .eq("status", existing.status)
    .select("id");

  if (error) {
    throw dbError(error);
  }
  assertClaimed(claimed, "complaint");

  await logAudit(supabase, actor, `complaint_${status}`, "complaints", complaintId, {
    oldValue: { status: existing.status },
    newValue: { status },
  });

  if (status === "resolved") {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: "Complaint resolved",
      message: `Your complaint "${existing.title}" has been marked resolved.`,
      receiver_id: existing.submitted_by,
      sender_id: actor.userId,
      type: "success",
      link: "/student/complaints",
    });
  }
}

export async function updateComplaintStatus(
  complaintId: string,
  status: "in_progress" | "resolved") {
  const actor = await requireRole(PERMISSIONS.hostel_complaint_manage);
  const supabase = await createClient();
  await updateComplaintStatusCore(supabase, actor, complaintId, status);
  revalidatePath("/warden/complaints");
  revalidatePath("/warden/dashboard");
  await invalidateCacheFamily(COMPLAINTS_CACHE_PREFIX, actor.collegeId);
}

/** Called by app/api/mobile/complaints/status/route.ts. */
export async function updateComplaintStatusViaRequest(
  request: Request,
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await updateComplaintStatusCore(supabase, actor, complaintId, status);
}
