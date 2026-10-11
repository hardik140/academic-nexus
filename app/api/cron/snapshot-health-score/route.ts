import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { unavailableCollegeIds } from "@/lib/college-access";
import type { Json } from "@/types/database";
import { businessRpc, num } from "@/lib/business-rpc";

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

interface HealthInputs {
  college_id: string;
  open_risk_flags: number | string;
  pending_decisions: number | string;
  faculty_count: number | string;
  active_students: number | string;
  hostel_capacity: number | string;
  hostel_occupancy: number | string;
  dept_with_attendance: number | string;
  dept_with_backlog: number | string;
  dept_with_cgpa: number | string;
  avg_attendance: number | string | null;
  avg_backlog_inverse: number | string | null;
  avg_cgpa_pct: number | string | null;
  dept_with_placement: number | string;
  avg_placement: number | string | null;
  fee_collection_pct: number | string | null;
}

async function handler() {
  const supabase = createAdminClient();

  // Every per-college input, computed in PostgreSQL (migration 059,
  // college_health_inputs; service role only). This used to read whole
  // tables across EVERY college — active students, faculty, open flags,
  // pending decisions, hostel rooms, the per-department health rows — and
  // filter them per college here. The service role is capped at PostgREST's
  // 1,000 rows like anyone else, and that cap applied to all colleges
  // TOGETHER, so once the platform passed 1,000 active students every
  // college's faculty ratio, and soon every other score, was wrong.
  // The scoring below is unchanged.
  const inputs = await businessRpc<HealthInputs>(supabase, "college_health_inputs", {});

  // Lifecycle-blocked (migration 053): no snapshot for a college in
  // MAINTENANCE or SUSPENDED.
  const blocked = await unavailableCollegeIds(supabase);
  let written = 0;

  for (const c of inputs) {
    const collegeId = c.college_id;
    if (collegeId === PLATFORM_COLLEGE_ID || blocked.has(collegeId)) continue;

    const completeness: Record<string, string> = {};

    // Academic: attendance (50%) + inverse backlog rate (30%) + CGPA/10 (20%),
    // each averaged over the departments that report it.
    let academicScore: number | null = null;
    if (num(c.dept_with_attendance) && num(c.dept_with_backlog) && num(c.dept_with_cgpa)) {
      academicScore = round1(num(c.avg_attendance) * 0.5 + num(c.avg_backlog_inverse) * 0.3 + num(c.avg_cgpa_pct) * 0.2);
    }
    if (academicScore == null) completeness.academic_score = "insufficient_data";

    // Fee collection: direct from mv_fee_summary.
    const feeScore = c.fee_collection_pct != null ? round1(num(c.fee_collection_pct)) : null;
    if (feeScore == null) completeness.fee_collection_score = "insufficient_data";

    // Placement: average department placement_rate.
    const placementScore = num(c.dept_with_placement) ? round1(num(c.avg_placement)) : null;
    if (placementScore == null) completeness.placement_score = "insufficient_data";

    // Hostel: penalize occupancy above 85% capacity; no blocks = insufficient data.
    const totalCapacity = num(c.hostel_capacity);
    const totalOccupancy = num(c.hostel_occupancy);
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
    const facultyCount = num(c.faculty_count);
    const studentCount = num(c.active_students);
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

    const riskOpenCount = num(c.open_risk_flags);
    const decisionsPendingCount = num(c.pending_decisions);

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
