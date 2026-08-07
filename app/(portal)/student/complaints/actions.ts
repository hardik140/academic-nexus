"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type ComplaintCategory = Database["public"]["Tables"]["complaints"]["Row"]["category"];
type ComplaintPriority = Database["public"]["Tables"]["complaints"]["Row"]["priority"];

export interface SubmitComplaintParams {
  category: ComplaintCategory;
  title: string;
  description: string;
  location: string;
  priority: ComplaintPriority;
}

/** Shared by the web Server Action and app/api/mobile/complaints/submit. */
export async function submitComplaintCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SubmitComplaintParams
) {
  await checkRateLimit(`submitComplaint:${actor.userId}`, 5, 60);

  const { error } = await supabase.from("complaints").insert({
    college_id: actor.collegeId,
    submitted_by: actor.userId,
    category: params.category,
    title: params.title,
    description: params.description,
    location: params.location,
    priority: params.priority,
    status: "open",
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function submitComplaint(params: SubmitComplaintParams) {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  await submitComplaintCore(supabase, actor, params);
  revalidatePath("/student/complaints");
}

/** Called by app/api/mobile/complaints/submit/route.ts. */
export async function submitComplaintViaRequest(request: Request, params: SubmitComplaintParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["student"]);
  await submitComplaintCore(supabase, actor, params);
}
