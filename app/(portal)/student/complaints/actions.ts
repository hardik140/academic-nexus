"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type ComplaintCategory = Database["public"]["Tables"]["complaints"]["Row"]["category"];
type ComplaintPriority = Database["public"]["Tables"]["complaints"]["Row"]["priority"];

const COMPLAINT_CATEGORIES = [
  "plumbing", "electrical", "ac_hvac", "carpentry", "cleaning", "internet",
  "safety", "ragging", "academic", "hostel", "mess", "other",
] as const;
const COMPLAINT_PRIORITIES = ["low", "medium", "high", "critical"] as const;

const SubmitComplaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  location: z.string().trim().min(1).max(200),
  priority: z.enum(COMPLAINT_PRIORITIES),
});

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
  const { category, title, description, location, priority } = SubmitComplaintSchema.parse(params);
  await checkRateLimit(`submitComplaint:${actor.userId}`, 5, 60);

  const { error } = await supabase.from("complaints").insert({
    college_id: actor.collegeId,
    submitted_by: actor.userId,
    category,
    title,
    description,
    location,
    priority,
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
