"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { assertRead } from "@/lib/read-result-server";
import { businessRpc, num } from "@/lib/business-rpc";

/**
 * Institution-wide version of warden/dashboard's per-warden tiles — same
 * shape, all blocks in the college rather than just the ones a single
 * warden manages. Relies on migration 034's additive Director read
 * policies for complaints/gate_passes (hostel_blocks/rooms/allocations
 * were already Director-readable, see migration 006).
 */
export async function getHostelRollup() {
  const actor = await requireRole(PERMISSIONS.hostel_institution_rollup_read);
  const supabase = await createClient();

  return getCached(`hostel-rollup:${actor.collegeId}`, 60, async () => {
    // Capacity and occupancy are summed per block in PostgreSQL (migration
    // 059, hostel_block_capacity), and the two counts are PostgreSQL's
    // (count: "exact"). This used to read every room, every pending gate
    // pass and every open complaint — each capped at PostgREST's 1,000 rows —
    // and add them up here.
    const [blocksRes, capacityRows, gatePassesRes, complaintsRes] = await Promise.all([
      supabase.from("hostel_blocks").select("*").eq("college_id", actor.collegeId),
      businessRpc<{ block_id: string; capacity: number | string; occupancy: number | string }>(supabase, "hostel_block_capacity", {
        p_college_id: actor.collegeId,
      }),
      supabase
        .from("gate_passes")
        .select("id", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("status", "pending"),
      supabase
        .from("complaints")
        .select("id", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("status", "open")
        .in("category", ["hostel", "mess", "plumbing", "electrical", "cleaning"]),
    ]);
    assertRead(blocksRes.error);
    assertRead(gatePassesRes.error);
    assertRead(complaintsRes.error);

    const blocks = blocksRes.data || [];
    const byBlock = new Map(capacityRows.map((r) => [r.block_id, r]));

    const blockBreakdown = blocks.map((b) => {
      const capacity = num(byBlock.get(b.id)?.capacity);
      const occupancy = num(byBlock.get(b.id)?.occupancy);
      return {
        id: b.id,
        name: b.name,
        type: b.type,
        status: b.status,
        capacity,
        occupancy,
        occupancyPct: capacity > 0 ? Math.round((occupancy / capacity) * 1000) / 10 : null,
      };
    });

    const totalCapacity = blockBreakdown.reduce((s, b) => s + b.capacity, 0);
    const totalOccupancy = blockBreakdown.reduce((s, b) => s + b.occupancy, 0);

    return {
      totalBlocks: blocks.length,
      totalCapacity,
      totalOccupancy,
      occupancyPct: totalCapacity > 0 ? Math.round((totalOccupancy / totalCapacity) * 1000) / 10 : null,
      pendingGatePasses: gatePassesRes.count ?? 0,
      openComplaints: complaintsRes.count ?? 0,
      blocks: blockBreakdown,
    };
  });
}
