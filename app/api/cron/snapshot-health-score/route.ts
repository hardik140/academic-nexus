import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { unavailableCollegeIds } from "@/lib/college-access";
import type { Json } from "@/types/database";

/**
 * Scheduled endpoint (QStash cron, same pattern as refresh-analytics and
 * detect-risk-flags) — computes one institution_metric_snapshots row per
 * college from real, already-computed data. This is what gives the Command
 * Center home a "trend" and a "what changed since last login" to diff
 * against; without a history table, both would have nothing to compare to.
 *
 * Every sub-score is either a real aggregate or explicitly recorded as
 * missing in data_completeness_flags — never defaulted to 0 or fabricated.
 * Infrastructure and Accreditation/Compliance sub-scores are not computed
 * at all in this pass (no data model exists for either — see the approved
 * plan's scope decision); the UI renders those two as "not tracked yet."
 */

const PLATFORM_COLLEGE_ID = "00000000-0000-0000-0000-000000000000";
const TARGET_STUDENT_FACULTY_RATIO = 15;

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

async function handler() {
  const supabase = createAdminClient();

  const [collegesRes, deptHealthRes, feeSummaryRes, riskFlagsRes, decisionsRes, profilesRes, studentsRes, hostelBlocksRes, hostelRoomsRes] =
    await Promise.all([
      supabase.from("colleges").select("id").neq("id", PLATFORM_COLLEGE_ID),
      supabase.from("mv_department_health_raw" as any).select("*"),
      supabase.from("mv_fee_summary_raw" as any).select("*"),
      supabase.from("risk_flags").select("college_id").in("status", ["open", "assigned", "acknowledged", "in_progress"]),
      supabase.from("decisions").select("college_id").eq("status", "pending"),
      supabase.from("profiles").select("college_id, role").in("role", ["teacher", "hod"]),
      supabase.from("students").select("college_id").eq("status", "active"),
      supabase.from("hostel_blocks").select("id, college_id"),
      supabase.from("hostel_rooms").select("block_id, capacity, occupancy"),
    ]);

  const deptHealth = (deptHealthRes.data || []) as any[];
  const feeSummary = (feeSummaryRes.data || []) as any[];
  const riskFlags = riskFlagsRes.data || [];
  const decisions = decisionsRes.data || [];
  const facultyProfiles = profilesRes.data || [];
  const activeStudents = studentsRes.data || [];
  const hostelBlocks = hostelBlocksRes.data || [];
  const hostelRooms = hostelRoomsRes.data || [];

  // Lifecycle-blocked (migration 053): no snapshot for a college in
  // MAINTENANCE or SUSPENDED.
  const blocked = await unavailableCollegeIds(supabase);
  const colleges = (collegesRes.data || []).filter((c) => !blocked.has(c.id));
  let written = 0;

  for (const college of colleges) {
    const collegeId = college.id;
    const depts = deptHealth.filter((d) => d.college_id === collegeId);
    const fee = feeSummary.find((f) => f.college_id === collegeId);

    const completeness: Record<string, string> = {};

    // Academic: attendance (50%) + inverse backlog rate (30%) + CGPA/10 (20%).
    let academicScore: number | null = null;
    if (depts.length > 0) {
      const withAttendance = depts.filter((d) => d.attendance_pct != null);
      const withBacklog = depts.filter((d) => d.backlog_rate != null);
      const withCgpa = depts.filter((d) => d.avg_cgpa != null);
      if (withAttendance.length && withBacklog.length && withCgpa.length) {
        const avgAttendance = withAttendance.reduce((s, d) => s + d.attendance_pct, 0) / withAttendance.length;
        const avgBacklogInverse = withBacklog.reduce((s, d) => s + Math.max(0, 100 - d.backlog_rate), 0) / withBacklog.length;
        const avgCgpaPct = withCgpa.reduce((s, d) => s + (d.avg_cgpa / 10) * 100, 0) / withCgpa.length;
        academicScore = round1(avgAttendance * 0.5 + avgBacklogInverse * 0.3 + avgCgpaPct * 0.2);
      }
    }
    if (academicScore == null) completeness.academic_score = "insufficient_data";

    // Fee collection: direct from mv_fee_summary.
    const feeScore = fee?.collection_pct != null ? round1(fee.collection_pct) : null;
    if (feeScore == null) completeness.fee_collection_score = "insufficient_data";

    // Placement: average department placement_rate.
    const withPlacement = depts.filter((d) => d.placement_rate != null);
    const placementScore = withPlacement.length ? round1(withPlacement.reduce((s, d) => s + d.placement_rate, 0) / withPlacement.length) : null;
    if (placementScore == null) completeness.placement_score = "insufficient_data";

    // Hostel: penalize occupancy above 85% capacity; no blocks = insufficient data.
    const collegeBlocks = hostelBlocks.filter((b) => b.college_id === collegeId).map((b) => b.id);
    const collegeRooms = hostelRooms.filter((r) => collegeBlocks.includes(r.block_id));
    const totalCapacity = collegeRooms.reduce((s, r) => s + r.capacity, 0);
    const totalOccupancy = collegeRooms.reduce((s, r) => s + r.occupancy, 0);
    let hostelScore: number | null = null;
    if (totalCapacity > 0) {
      const occupancyPct = (totalOccupancy / totalCapacity) * 100;
      hostelScore = round1(Math.max(0, 100 - Math.max(0, occupancyPct - 85) * 2));
    } else {
      completeness.hostel_score = "insufficient_data";
    }

    // Faculty: student:faculty ratio vs a 15:1 target — real counts, simple
    // capacity signal. Distinct from (and a precursor to) the richer
    // workload-completion signal planned for Faculty Intelligence.
    const facultyCount = facultyProfiles.filter((p) => p.college_id === collegeId).length;
    const studentCount = activeStudents.filter((s) => s.college_id === collegeId).length;
    let facultyScore: number | null = null;
    if (facultyCount > 0 && studentCount > 0) {
      const actualRatio = studentCount / facultyCount;
      facultyScore = round1(Math.min(100, (TARGET_STUDENT_FACULTY_RATIO / actualRatio) * 100));
    } else {
      completeness.faculty_score = "insufficient_data";
    }

    completeness.infrastructure_score = "not_tracked";
    completeness.compliance_score = "not_tracked";

    const scores = [academicScore, feeScore, placementScore, hostelScore, facultyScore].filter((s): s is number => s != null);
    const overallScore = scores.length > 0 ? round1(scores.reduce((s, v) => s + v, 0) / scores.length) : null;

    const riskOpenCount = riskFlags.filter((f) => f.college_id === collegeId).length;
    const decisionsPendingCount = decisions.filter((d) => d.college_id === collegeId).length;

    await supabase.from("institution_metric_snapshots").insert({
      college_id: collegeId,
      overall_score: overallScore,
      academic_score: academicScore,
      fee_collection_score: feeScore,
      placement_score: placementScore,
      hostel_score: hostelScore,
      faculty_score: facultyScore,
      risk_open_count: riskOpenCount,
      decisions_pending_count: decisionsPendingCount,
      data_completeness_flags: completeness as Json,
    });
    written++;
  }

  return NextResponse.json({ ok: true, collegesSnapshotted: written });
}

const hasQstashKeys = !!(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);
const verifiedHandler = hasQstashKeys ? verifySignatureAppRouter(handler) : null;

export async function POST(request: Request) {
  if (!verifiedHandler) {
    return NextResponse.json({ ok: false, error: "QStash signing keys are not configured." }, { status: 503 });
  }
  try {
    return await verifiedHandler(request);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }
}
