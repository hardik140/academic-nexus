"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";

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
    const [blocksRes, roomsRes, gatePassesRes, complaintsRes] = await Promise.all([
      supabase.from("hostel_blocks").select("*").eq("college_id", actor.collegeId),
      supabase.from("hostel_rooms").select("block_id, capacity, occupancy").eq("college_id", actor.collegeId),
      supabase
        .from("gate_passes")
        .select("id")
        .eq("college_id", actor.collegeId)
        .eq("status", "pending"),
      supabase
        .from("complaints")
        .select("id, category")
        .eq("college_id", actor.collegeId)
        .eq("status", "open")
        .in("category", ["hostel", "mess", "plumbing", "electrical", "cleaning"]),
    ]);

    const blocks = blocksRes.data || [];
    const rooms = roomsRes.data || [];

    const blockBreakdown = blocks.map((b) => {
      const blockRooms = rooms.filter((r) => r.block_id === b.id);
      const capacity = blockRooms.reduce((s, r) => s + r.capacity, 0);
      const occupancy = blockRooms.reduce((s, r) => s + r.occupancy, 0);
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
      pendingGatePasses: gatePassesRes.data?.length || 0,
      openComplaints: complaintsRes.data?.length || 0,
      blocks: blockBreakdown,
    };
  });
}
