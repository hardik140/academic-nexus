"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Database } from "@/types/database";

type ComplaintCategory = Database["public"]["Tables"]["complaints"]["Row"]["category"];
type ComplaintPriority = Database["public"]["Tables"]["complaints"]["Row"]["priority"];

export async function submitComplaint(params: {
  category: ComplaintCategory;
  title: string;
  description: string;
  location: string;
  priority: ComplaintPriority;
}) {
  const actor = await requireRole(["student"]);
  await checkRateLimit(`submitComplaint:${actor.userId}`, 5, 60);
  const supabase = await createClient();

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

  revalidatePath("/student/complaints");
}
