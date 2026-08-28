"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

const ENTRY_TYPES = [
  "note",
  "info_request",
  "info_response",
  "evidence",
  "status_change",
  "assigned",
  "acknowledged",
  "resolved",
] as const;
const ENTITY_TYPES = ["decision", "risk_flag"] as const;

const AddNoteSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().guid(),
  entryType: z.enum(ENTRY_TYPES),
  body: z.string().trim().max(2000).optional(),
});

export type AddEscalationNoteParams = z.infer<typeof AddNoteSchema>;

/**
 * Shared by the Decision Inbox and the Attention Center — one thread shape
 * for both lifecycles (see migration 028). Any role that could plausibly
 * touch a decision or risk flag may call this; RLS
 * (escalation_notes_read/insert) is the real authorization boundary, since
 * "can write here" depends on entity-level assignment/ownership that only
 * the DB can check cheaply via the subqueries in that migration, not a flat
 * role list at this layer.
 */
const NOTE_ROLES = ["director", "hod", "warden", "placement_cell", "teacher"] as const;

export async function addEscalationNote(params: AddEscalationNoteParams) {
  const actor = await requireRole(NOTE_ROLES);
  const parsed = AddNoteSchema.parse(params);
  const supabase = await createClient();

  const { error } = await supabase.from("escalation_notes").insert({
    college_id: actor.collegeId,
    entity_type: parsed.entityType,
    entity_id: parsed.entityId,
    author_id: actor.userId,
    entry_type: parsed.entryType,
    body: parsed.body ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function listEscalationNotes(entityType: "decision" | "risk_flag", entityId: string) {
  const actor = await requireRole(NOTE_ROLES);
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("escalation_notes")
    .select("*, author:author_id(full_name, role)")
    .eq("college_id", actor.collegeId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }
  return data || [];
}
