"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const SUB_SCORE_LABELS: Record<string, string> = {
  academic_score: "Academic Health",
  fee_collection_score: "Financial (Fee Collection)",
  placement_score: "Placement Health",
  hostel_score: "Hostel Health",
  faculty_score: "Faculty Health",
};

export async function getExecutiveBriefing() {
  const actor = await requireRole(PERMISSIONS.executive_briefing_read);
  const supabase = await createClient();

  // Cast to any: this hand-maintained types file doesn't declare table
  // Relationships, so the embedded department:department_id(...) join
  // collapses this Promise.all tuple's inference — same pattern used
  // throughout the app.
  const [snapshotsRes, risksRes, decisionsRes, goalsRes] = (await Promise.all([
    supabase
      .from("institution_metric_snapshots")
      .select("*")
      .eq("college_id", actor.collegeId)
      .order("snapshot_at", { ascending: false })
      .limit(2),
    supabase
      .from("risk_flags")
      .select("id, title, severity, department:department_id(name)")
      .eq("college_id", actor.collegeId)
      .in("status", ["open", "assigned", "acknowledged", "in_progress"])
      .order("severity", { ascending: false })
      .limit(3),
    supabase
      .from("decisions")
      .select("id, title, urgency, deadline")
      .eq("college_id", actor.collegeId)
      .eq("status", "pending")
      .order("urgency", { ascending: false })
      .limit(3),
    supabase.from("strategic_goals").select("id, title, target_date").eq("college_id", actor.collegeId).in("status", ["on_track", "at_risk"]).order("target_date", { ascending: true }).limit(3),
  ])) as any[];

  const [latest, prior] = snapshotsRes.data || [];

  const kpiChanges: { label: string; delta: number }[] = [];
  const positives: string[] = [];
  const risksFromScores: string[] = [];
  if (latest && prior) {
    for (const key of Object.keys(SUB_SCORE_LABELS)) {
      const latestVal = (latest as any)[key];
      const priorVal = (prior as any)[key];
      if (latestVal == null || priorVal == null) continue;
      const delta = Math.round((latestVal - priorVal) * 10) / 10;
      if (delta === 0) continue;
      kpiChanges.push({ label: SUB_SCORE_LABELS[key], delta });
      if (delta > 0) positives.push(`${SUB_SCORE_LABELS[key]} improved by ${delta} points`);
      else risksFromScores.push(`${SUB_SCORE_LABELS[key]} declined by ${Math.abs(delta)} points`);
    }
  }

  const risks: any[] = risksRes.data || [];
  const decisions: any[] = decisionsRes.data || [];
  const goals: any[] = goalsRes.data || [];

  const recommendedActions: string[] = [];
  if (decisions.length > 0) recommendedActions.push(`Review ${decisions.length} pending decision${decisions.length === 1 ? "" : "s"} in the Decision Inbox.`);
  const criticalRisks = risks.filter((r: any) => r.severity === "critical" || r.severity === "high");
  if (criticalRisks.length > 0) recommendedActions.push(`Address ${criticalRisks.length} high/critical risk flag${criticalRisks.length === 1 ? "" : "s"} in the Attention Center.`);
  if (risksFromScores.length > 0) recommendedActions.push("Investigate the declining metrics listed under Risks below.");
  if (recommendedActions.length === 0) recommendedActions.push("No urgent action items — institution is tracking normally.");

  await supabase
    .from("command_center_view_state")
    .upsert({ user_id: actor.userId, college_id: actor.collegeId, last_briefing_generated_at: new Date().toISOString() });

  return {
    generatedAt: new Date().toISOString(),
    latestSnapshot: latest || null,
    hasComparison: !!(latest && prior),
    kpiChanges,
    positives: positives.slice(0, 3),
    risks: [...risks.map((r: any) => `${r.title}${r.department ? ` (${r.department.name})` : ""} — ${r.severity}`), ...risksFromScores].slice(0, 3),
    decisionsWaiting: decisions,
    upcomingDeadlines: [
      ...decisions.filter((d: any) => d.deadline).map((d: any) => ({ label: d.title, date: d.deadline as string })),
      ...goals.filter((g: any) => g.target_date).map((g: any) => ({ label: g.title, date: g.target_date })),
    ]
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(0, 5),
    escalationsInProgress: risks.length,
    recommendedActions,
  };
}
