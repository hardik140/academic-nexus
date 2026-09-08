"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import type { QuestionKey } from "./questions";

export interface AnswerResult {
  answer: string;
  supportingMetrics: string[];
  dataSource: string;
  drillDownUrl: string | null;
  insufficientData: boolean;
}

/**
 * Curated-question Q&A — no LLM, every answer is a real query against the
 * same tables/views every other Command Center screen reads. When a
 * question has no honest answer (e.g. spending — no budget data model
 * exists), it says so explicitly rather than fabricating one, per the
 * "never invent data" rule this whole feature is built around.
 */
export async function answerQuestion(key: QuestionKey): Promise<AnswerResult> {
  const actor = await requireRole(PERMISSIONS.ask_institution_read);
  const supabase = await createClient();

  switch (key) {
    case "attention_department": {
      // Cast to any: this hand-maintained types file doesn't declare table
      // Relationships, so the embedded departments:department_id(...) join
      // can't be inferred — same pattern used throughout the rest of the app.
      const { data: flags } = (await supabase
        .from("risk_flags")
        .select("department_id, departments:department_id(name)")
        .eq("college_id", actor.collegeId)
        .in("status", ["open", "assigned", "acknowledged", "in_progress"])
        .not("department_id", "is", null)) as any;
      if (!flags || flags.length === 0) {
        return {
          answer: "No department currently has open risk flags.",
          supportingMetrics: [],
          dataSource: "risk_flags",
          drillDownUrl: "/director/attention",
          insufficientData: false,
        };
      }
      const counts = new Map<string, { name: string; count: number }>();
      for (const f of flags as any[]) {
        const id = f.department_id;
        const name = f.departments?.name || "Unknown";
        counts.set(id, { name, count: (counts.get(id)?.count || 0) + 1 });
      }
      const worst = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0];
      return {
        answer: `${worst.name} needs the most attention — ${worst.count} open risk flag${worst.count === 1 ? "" : "s"}.`,
        supportingMetrics: [`${worst.count} open flags in ${worst.name}`],
        dataSource: "risk_flags",
        drillDownUrl: "/director/attention",
        insufficientData: false,
      };
    }

    case "attendance_below_target": {
      const { data } = await supabase.from("mv_department_health").select("department_name, attendance_pct").not("attendance_pct", "is", null);
      const below = (data || []).filter((d) => (d.attendance_pct as number) < 75);
      if (!data || data.length === 0) {
        return { answer: "Insufficient data — no attendance data available yet.", supportingMetrics: [], dataSource: "mv_department_health", drillDownUrl: null, insufficientData: true };
      }
      return {
        answer: below.length === 0 ? "No departments are below the 75% attendance target." : `${below.length} department${below.length === 1 ? " is" : "s are"} below the 75% attendance target: ${below.map((d) => `${d.department_name} (${d.attendance_pct}%)`).join(", ")}.`,
        supportingMetrics: below.map((d) => `${d.department_name}: ${d.attendance_pct}%`),
        dataSource: "mv_department_health",
        drillDownUrl: "/director/departments/performance",
        insufficientData: false,
      };
    }

    case "student_risk": {
      const { data: students } = await supabase.from("students").select("id").eq("college_id", actor.collegeId).eq("status", "active");
      if (!students || students.length === 0) {
        return { answer: "Insufficient data — no active student records available yet.", supportingMetrics: [], dataSource: "students", drillDownUrl: null, insufficientData: true };
      }
      return {
        answer: "See the Attention Center's Student Risk Overview for a real-time, department-by-department breakdown of at-risk and critical student counts.",
        supportingMetrics: [`${students.length} active students institution-wide`],
        dataSource: "students, fees, course_enrollments",
        drillDownUrl: "/director/attention",
        insufficientData: false,
      };
    }

    case "placement_trend": {
      const { data: snapshots } = await supabase
        .from("institution_metric_snapshots")
        .select("placement_score, snapshot_at")
        .eq("college_id", actor.collegeId)
        .not("placement_score", "is", null)
        .order("snapshot_at", { ascending: false })
        .limit(2);
      if (!snapshots || snapshots.length < 2) {
        return { answer: "Insufficient data — need at least two health-score snapshots with placement data to detect a trend.", supportingMetrics: [], dataSource: "institution_metric_snapshots", drillDownUrl: "/director/placements/funnel", insufficientData: true };
      }
      const [latest, prior] = snapshots;
      const delta = Math.round(((latest.placement_score as number) - (prior.placement_score as number)) * 10) / 10;
      return {
        answer: delta === 0 ? "Placement has held steady since the last snapshot." : `Placement is trending ${delta > 0 ? "up" : "down"} — ${Math.abs(delta)} points since the last snapshot.`,
        supportingMetrics: [`Latest: ${latest.placement_score}`, `Previous: ${prior.placement_score}`],
        dataSource: "institution_metric_snapshots",
        drillDownUrl: "/director/placements/funnel",
        insufficientData: false,
      };
    }

    case "goals_behind": {
      const { data } = await supabase
        .from("strategic_goals")
        .select("title, status")
        .eq("college_id", actor.collegeId)
        .in("status", ["at_risk", "off_track"]);
      if (!data || data.length === 0) {
        return { answer: "No strategic goals are currently flagged at-risk or off-track.", supportingMetrics: [], dataSource: "strategic_goals", drillDownUrl: "/director/goals", insufficientData: false };
      }
      return {
        answer: `${data.length} goal${data.length === 1 ? " is" : "s are"} behind schedule: ${data.map((g) => g.title).join(", ")}.`,
        supportingMetrics: data.map((g) => `${g.title}: ${g.status.replace(/_/g, " ")}`),
        dataSource: "strategic_goals",
        drillDownUrl: "/director/goals",
        insufficientData: false,
      };
    }

    case "overspending":
      return {
        answer: "Insufficient data — this ERP has no budget or expenditure data model yet (only student fee collection is tracked). Overspending can't be answered honestly until a budget module exists.",
        supportingMetrics: [],
        dataSource: "none",
        drillDownUrl: null,
        insufficientData: true,
      };
  }
}
