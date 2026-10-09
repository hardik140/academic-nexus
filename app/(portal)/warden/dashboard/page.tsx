import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCachedWriteBehind } from "@/lib/cache";
import { RequestDecisionButton } from "@/components/portal/request-decision-modal";
import { DirectorEscalationsPanel } from "@/components/portal/director-escalations-panel";
import { listPendingGatePasses, getGateOperationsSnapshot } from "../gatepasses/actions";
import { listRoomTransferRequests } from "../transfers/actions";
import { assertRead } from "@/lib/read-result-server";

interface AttentionItem {
  label: string;
  count: number;
  href: string;
  severity: "high" | "medium" | "low";
}

export default async function WardenDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { blocks, rooms, openComplaints } = await getCachedWriteBehind(
    `dashboard:warden:${user.id}:overview`,
    60,
    async () => {
      const { data: blocks, error: blocksError } = await supabase.from("hostel_blocks").select("*").eq("warden_id", user.id);
      assertRead(blocksError);
      const blockIds = (blocks || []).map((b) => b.id);

      const [roomsRes, complaintsRes] = await Promise.all([
        blockIds.length ? supabase.from("hostel_rooms").select("*").in("block_id", blockIds) : Promise.resolve({ data: [] }),
        supabase.from("complaints").select("*").eq("status", "open").in("category", ["hostel", "mess", "plumbing", "electrical", "cleaning"]).order("created_at", { ascending: false }).limit(5),
      ]);
      for (const res of [roomsRes, complaintsRes]) assertRead("error" in res ? res.error : null);

      return {
        blocks: blocks || [],
        rooms: roomsRes.data || [],
        openComplaints: complaintsRes.data || [],
      };
    }
  );
  const totalCapacity = rooms.reduce((s, r: any) => s + r.capacity, 0);
  const totalOccupancy = rooms.reduce((s, r: any) => s + r.occupancy, 0);
  const occupancyPct = totalCapacity > 0 ? (totalOccupancy / totalCapacity) * 100 : 0;

  // "What needs my attention right now?" — pendingGatePasses/roomTransfers
  // are now block-scoped (see the IDOR fix in gatepasses/actions.ts —
  // previously any warden could see/act on ANY block's gate passes).
  const [pendingGatePasses, transfers, gateOps] = await Promise.all([
    listPendingGatePasses(),
    listRoomTransferRequests(),
    getGateOperationsSnapshot(),
  ]);

  const allActionItems: AttentionItem[] = [
    { label: "pending gate pass request", count: pendingGatePasses.length, href: "/warden/gatepasses", severity: "high" },
    { label: "pending room transfer request", count: transfers.pending.length, href: "/warden/transfers", severity: "medium" },
    { label: "open hostel complaint", count: openComplaints.length, href: "/warden/complaints", severity: "medium" },
  ];
  const actionItems = allActionItems.filter((i) => i.count > 0);

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Warden Dashboard</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Hostel occupancy, gate passes, and maintenance overview</p>
        </div>
        <RequestDecisionButton />
      </div>

      {/* Residential Presence — In Hostel / Outside, computed from active
          gate passes; NOT academic attendance. */}
      <div className="grid grid-cols-2 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">In Hostel</div>
          <div className="text-2xl font-extrabold text-success">{gateOps.inHostelCount}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Outside</div>
          <div className="text-2xl font-extrabold text-secondary">{gateOps.outsideCount}</div>
        </div>
      </div>

      {/* Action Required */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">Action Required</h2>
          <span className="text-xs font-semibold text-outline">{actionItems.length} item{actionItems.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="divide-y divide-outline-variant">
          {actionItems.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">🎉 Nothing needs your attention right now.</div>
          ) : (
            actionItems.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
              >
                <span className="text-sm text-on-surface">
                  <span className={`font-bold ${item.severity === "high" ? "text-error" : "text-warning"}`}>{item.count}</span>{" "}
                  {item.label}{item.count !== 1 ? "s" : ""}
                </span>
                <span className="text-xs font-semibold text-secondary">View →</span>
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Hostel Exceptions — deterministic rules over real data, not AI */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Hostel Exceptions</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {gateOps.lateReturns.map((r) => (
            <Link key={r.passId} href="/warden/gatepasses" className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <span className="text-sm text-on-surface">
                <span className="font-bold text-error">Late Return</span> — {r.studentName}, {r.minutesLate} min overdue
              </span>
              <span className="text-xs font-semibold text-secondary">View →</span>
            </Link>
          ))}
          {gateOps.pendingExitVerifications.map((r) => (
            <Link key={r.passId} href="/warden/gatepasses" className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <span className="text-sm text-on-surface">
                <span className="font-bold text-warning">Pending Exit Verification</span> — {r.studentName}, {r.minutesOverdue} min since approved exit time
              </span>
              <span className="text-xs font-semibold text-secondary">View →</span>
            </Link>
          ))}
          {gateOps.lateReturns.length === 0 && gateOps.pendingExitVerifications.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No hostel exceptions detected.</div>
          )}
          {(gateOps.lateReturnCount > gateOps.lateReturns.length ||
            gateOps.pendingExitCount > gateOps.pendingExitVerifications.length) && (
            <div className="px-lg py-md text-xs text-outline">
              Showing the oldest {gateOps.lateReturns.length} of {gateOps.lateReturnCount} late returns and{" "}
              {gateOps.pendingExitVerifications.length} of {gateOps.pendingExitCount} pending exit verifications.
            </div>
          )}
        </div>
      </div>

      <DirectorEscalationsPanel />

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
            {pendingGatePasses.length > 0 ? pendingGatePasses.slice(0, 5).map((p: any) => (
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
