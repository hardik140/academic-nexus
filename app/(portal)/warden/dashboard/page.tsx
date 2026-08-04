import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function WardenDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: blocks } = await supabase.from("hostel_blocks").select("*").eq("warden_id", user.id);
  const blockIds = (blocks || []).map((b) => b.id);

  const [roomsRes, gatePassesRes, complaintsRes] = await Promise.all([
    blockIds.length ? supabase.from("hostel_rooms").select("*").in("block_id", blockIds) : Promise.resolve({ data: [] }),
    supabase.from("gate_passes").select("*, students:student_id(profiles:user_id(full_name))").eq("status", "pending").order("created_at", { ascending: false }).limit(5),
    supabase.from("complaints").select("*").eq("status", "open").in("category", ["hostel", "mess", "plumbing", "electrical", "cleaning"]).order("created_at", { ascending: false }).limit(5),
  ]);

  const rooms = roomsRes.data || [];
  const totalCapacity = rooms.reduce((s, r: any) => s + r.capacity, 0);
  const totalOccupancy = rooms.reduce((s, r: any) => s + r.occupancy, 0);
  const occupancyPct = totalCapacity > 0 ? (totalOccupancy / totalCapacity) * 100 : 0;

  const pendingGatePasses = gatePassesRes.data || [];
  const openComplaints = complaintsRes.data || [];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Warden Dashboard</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Hostel occupancy, gate passes, and maintenance overview</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Blocks Managed</div>
          <div className="text-2xl font-extrabold text-on-surface">{(blocks || []).length}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Occupancy</div>
          <div className="text-2xl font-extrabold text-secondary">{totalOccupancy}/{totalCapacity}</div>
          <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div className="h-full bg-secondary rounded-full" style={{ width: `${Math.min(occupancyPct, 100)}%` }} />
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Pending Gate Passes</div>
          <div className="text-2xl font-extrabold text-warning">{pendingGatePasses.length}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Open Complaints</div>
          <div className="text-2xl font-extrabold text-error">{openComplaints.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">Pending Gate Passes</h2>
            <a href="/warden/gatepasses" className="text-xs font-medium text-secondary hover:underline">View All →</a>
          </div>
          <div className="divide-y divide-outline-variant">
            {pendingGatePasses.length > 0 ? pendingGatePasses.map((p: any) => (
              <div key={p.id} className="px-lg py-md">
                <div className="text-sm font-medium text-on-surface">{(p.students as any)?.profiles?.full_name || "—"}</div>
                <div className="text-xs text-outline">{p.destination} • {new Date(p.exit_time).toLocaleString()}</div>
              </div>
            )) : (
              <div className="p-xl text-center text-sm text-outline">No pending gate passes.</div>
            )}
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">Open Complaints</h2>
            <a href="/warden/complaints" className="text-xs font-medium text-secondary hover:underline">View All →</a>
          </div>
          <div className="divide-y divide-outline-variant">
            {openComplaints.length > 0 ? openComplaints.map((c: any) => (
              <div key={c.id} className="px-lg py-md">
                <div className="text-sm font-medium text-on-surface">{c.title}</div>
                <div className="text-xs text-outline capitalize">{c.category} • {c.priority} priority</div>
              </div>
            )) : (
              <div className="p-xl text-center text-sm text-outline">🎉 No open complaints.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
