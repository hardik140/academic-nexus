import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { unavailableCollegeIds } from "@/lib/college-access";
import type { Database } from "@/types/database";
import { businessRpc, num } from "@/lib/business-rpc";

/** Open flags read per page when auto-resolving. */
const FLAG_PAGE = 1000;

/**
 * Scheduled endpoint (QStash cron, same pattern as
 * app/api/cron/refresh-analytics/route.ts) — computes institution-wide risk
 * signals from real, already-computed data (mv_department_health_raw,
 * hostel occupancy) and writes/clears public.risk_flags rows.
 *
 * Uses the service-role client throughout: the underlying materialized
 * views' RLS-wrapper pattern (migration 011/032/033) filters by
 * get_my_college_id(), which resolves via auth.uid() — a service-role JWT
 * has no such user, so this reads the _raw relations directly (unfiltered
 * by college) and scopes manually per-row instead.
 *
 * Idempotent by design: an already-open flag for the same
 * (college_id, flag_type, department_id) is left alone rather than
 * duplicated on every run; a flag whose signal has since cleared is
 * auto-resolved with a system note, so the Attention Center never
 * accumulates stale entries. Only flags with status IN
 * ('open','assigned','acknowledged','in_progress') are matched/touched —
 * a 'dismissed' or already-'resolved' flag is left as Director last set it.
 */

type DeptHealthRow = Database["public"]["Views"]["mv_department_health"]["Row"];

interface Signal {
  collegeId: string;
  departmentId: string | null;
  flagType: Database["public"]["Tables"]["risk_flags"]["Row"]["flag_type"];
  severity: Database["public"]["Tables"]["risk_flags"]["Row"]["severity"];
  scopeLevel: Database["public"]["Tables"]["risk_flags"]["Row"]["scope_level"];
  title: string;
  description: string;
  affectedCount: number | null;
}

function attendanceSignal(row: DeptHealthRow): Signal | null {
  const pct = row.attendance_pct;
  if (pct == null) return null;
  let severity: Signal["severity"] | null = null;
  if (pct < 60) severity = "critical";
  else if (pct < 70) severity = "high";
  else if (pct < 75) severity = "medium";
  if (!severity) return null;
  return {
    collegeId: row.college_id,
    departmentId: row.department_id,
    flagType: "attendance_decline",
    severity,
    scopeLevel: "department",
    title: `${row.department_name} attendance below target`,
    description: `Department-wide attendance is ${pct}%, below the 75% target.`,
    affectedCount: row.total_students,
  };
}

function backlogSignal(row: DeptHealthRow): Signal | null {
  const rate = row.backlog_rate;
  if (rate == null) return null;
  let severity: Signal["severity"] | null = null;
  if (rate > 30) severity = "critical";
  else if (rate > 20) severity = "high";
  else if (rate > 10) severity = "medium";
  if (!severity) return null;
  return {
    collegeId: row.college_id,
    departmentId: row.department_id,
    flagType: "academic_backlog",
    severity,
    scopeLevel: "department",
    title: `${row.department_name} backlog rate elevated`,
    description: `${row.backlog_count} failed course enrollment(s) — a ${rate}% backlog rate.`,
    affectedCount: row.backlog_count,
  };
}

function feeSignal(row: DeptHealthRow): Signal | null {
  const pct = row.fee_collection_pct;
  if (pct == null) return null;
  let severity: Signal["severity"] | null = null;
  if (pct < 50) severity = "critical";
  else if (pct < 65) severity = "high";
  else if (pct < 75) severity = "medium";
  if (!severity) return null;
  return {
    collegeId: row.college_id,
    departmentId: row.department_id,
    flagType: "fee_overdue",
    severity,
    scopeLevel: "department",
    title: `${row.department_name} fee collection lagging`,
    description: `Fee collection is at ${pct}% for this department.`,
    affectedCount: null,
  };
}

function placementSignal(row: DeptHealthRow): Signal | null {
  const rate = row.placement_rate;
  if (rate == null) return null;
  let severity: Signal["severity"] | null = null;
  if (rate < 20) severity = "critical";
  else if (rate < 35) severity = "high";
  else if (rate < 50) severity = "medium";
  if (!severity) return null;
  return {
    collegeId: row.college_id,
    departmentId: row.department_id,
    flagType: "placement_inactivity",
    severity,
    scopeLevel: "department",
    title: `${row.department_name} placement rate below target`,
    description: `Only ${rate}% of active students in this department are placed.`,
    affectedCount: row.total_students,
  };
}

async function hostelSignals(
  supabase: ReturnType<typeof createAdminClient>
): Promise<Signal[]> {
  // Per-block capacity summed in PostgreSQL (migration 059,
  // hostel_block_capacity_all; service role only). Reading every room of
  // every college here was capped at PostgREST's 1,000 rows across the whole
  // platform, so blocks past the cap read empty and an over-capacity block
  // could go unflagged.
  let perBlock: { college_id: string; block_id: string; block_name: string; capacity: number | string; occupancy: number | string }[];
  try {
    perBlock = await businessRpc(supabase, "hostel_block_capacity_all", {});
  } catch {
    return [];
  }

  const byCollege = new Map<string, { blockId: string; name: string; capacity: number; occupancy: number }[]>();
  for (const block of perBlock) {
    const capacity = num(block.capacity);
    const occupancy = num(block.occupancy);
    if (capacity === 0) continue;
    const list = byCollege.get(block.college_id) || [];
    list.push({ blockId: block.block_id, name: block.block_name, capacity, occupancy });
    byCollege.set(block.college_id, list);
  }

  const signals: Signal[] = [];
  for (const [collegeId, list] of byCollege) {
    const overCapacity = list
      .map((b) => ({ ...b, pct: Math.round((b.occupancy / b.capacity) * 1000) / 10 }))
      .filter((b) => b.pct > 90);
    if (overCapacity.length === 0) continue;
    const worst = Math.max(...overCapacity.map((b) => b.pct));
    const severity: Signal["severity"] = worst > 98 ? "critical" : worst > 95 ? "high" : "medium";
    signals.push({
      collegeId,
      departmentId: null,
      flagType: "hostel_issue",
      severity,
      scopeLevel: "hostel_block",
      title: `${overCapacity.length} hostel block(s) near capacity`,
      description: overCapacity.map((b) => `${b.name} (${b.pct}%)`).join(", "),
      affectedCount: overCapacity.reduce((s, b) => s + b.occupancy, 0),
    });
  }
  return signals;
}

async function handler() {
  const supabase = createAdminClient();
  // Lifecycle-blocked (migration 053): a college in MAINTENANCE or SUSPENDED
  // gets no new flags — and keeps the ones it has, untouched, until it is
  // reactivated (they must not be auto-resolved just because it was skipped).
  const blocked = await unavailableCollegeIds(supabase);

  // Reads the _raw relation directly (not the mv_department_health wrapper
  // view) — see the file doc comment. Not a declared table/view in the
  // hand-maintained types file (it's an internal-only relation, only ever
  // touched by this cron), so the query builder needs an escape hatch here;
  // the result is cast back to the real Row shape immediately below.
  const { data: deptHealthRaw, error: deptHealthError } = await supabase
    .from("mv_department_health_raw" as any)
    .select("*");
  if (deptHealthError) {
    return NextResponse.json({ ok: false, error: deptHealthError.message }, { status: 500 });
  }
  const deptHealth = (deptHealthRaw || []) as unknown as DeptHealthRow[];

  const signals: Signal[] = [];
  for (const row of deptHealth) {
    for (const compute of [attendanceSignal, backlogSignal, feeSignal, placementSignal]) {
      const s = compute(row);
      if (s) signals.push(s);
    }
  }
  signals.push(...(await hostelSignals(supabase)));
  const liveSignals = signals.filter((s) => !blocked.has(s.collegeId));

  const OPEN_STATUSES = ["open", "assigned", "acknowledged", "in_progress"] as const;
  let created = 0;
  let updated = 0;
  let autoResolved = 0;

  for (const signal of liveSignals) {
    let query = supabase
      .from("risk_flags")
      .select("id, severity")
      .eq("college_id", signal.collegeId)
      .eq("flag_type", signal.flagType)
      .in("status", OPEN_STATUSES);
    query = signal.departmentId
      ? query.eq("department_id", signal.departmentId)
      : query.is("department_id", null);

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      if (existing.severity !== signal.severity) {
        await supabase
          .from("risk_flags")
          .update({ severity: signal.severity, description: signal.description, affected_count: signal.affectedCount })
          .eq("id", existing.id);
        updated++;
      }
      continue;
    }

    await supabase.from("risk_flags").insert({
      college_id: signal.collegeId,
      flag_type: signal.flagType,
      severity: signal.severity,
      scope_level: signal.scopeLevel,
      department_id: signal.departmentId,
      affected_count: signal.affectedCount,
      title: signal.title,
      description: signal.description,
      source: "system_computed",
      status: "open",
    });
    created++;
  }

  // Auto-resolve open system-computed flags whose signal has cleared —
  // EVERY open one, a keyset page (by id) at a time. One unranged select was
  // capped at PostgREST's 1,000 rows across all colleges, so flags past the
  // cap never auto-resolved. Keyset, not offset: resolving a flag removes it
  // from this set while we walk it, which would make an offset skip rows.
  const openSystemFlags: { id: string; college_id: string; flag_type: string; department_id: string | null }[] = [];
  for (let after = ""; ; ) {
    let page = supabase
      .from("risk_flags")
      .select("id, college_id, flag_type, department_id")
      .eq("source", "system_computed")
      .in("status", OPEN_STATUSES)
      .order("id", { ascending: true })
      .limit(FLAG_PAGE);
    if (after) page = page.gt("id", after);
    const { data, error } = await page;
    if (error || !data || data.length === 0) break;
    openSystemFlags.push(...data);
    if (data.length < FLAG_PAGE) break;
    after = data[data.length - 1].id;
  }

  for (const flag of openSystemFlags) {
    if (blocked.has(flag.college_id)) continue;
    const stillSignaled = liveSignals.some(
      (s) => s.collegeId === flag.college_id && s.flagType === flag.flag_type && s.departmentId === flag.department_id
    );
    if (!stillSignaled) {
      await supabase
        .from("risk_flags")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolution_notes: "Auto-resolved: underlying metric returned to normal range.",
        })
        .eq("id", flag.id);
      autoResolved++;
    }
  }

  return NextResponse.json({ ok: true, signalsDetected: liveSignals.length, created, updated, autoResolved, collegesSkipped: blocked.size });
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
