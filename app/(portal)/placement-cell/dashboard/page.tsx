import Link from "next/link";
import { StatsCard } from "@/components/ui/stats-card";
import { StatusBadge } from "@/components/ui/modal";
import { getPlacementCellDashboard } from "./actions";
import { listSentPlacementNotifications } from "../notifications/actions";
import { RequestDecisionButton } from "@/components/portal/request-decision-modal";
import { DirectorEscalationsPanel } from "@/components/portal/director-escalations-panel";

export default async function PlacementCellDashboard() {
  const [stats, notifications] = await Promise.all([
    getPlacementCellDashboard(),
    listSentPlacementNotifications(),
  ]);

  const recentNotifications = notifications.slice(0, 5);

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placement Dashboard</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Run the placement process for your college</p>
        </div>
        <RequestDecisionButton />
      </div>

      <DirectorEscalationsPanel />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <StatsCard label="Total Students" value={stats.totalStudents} icon="👥" />
        <StatsCard label="Eligible" value={stats.eligibleStudents} icon="✅" color="info" />
        <StatsCard label="Placed" value={stats.placed} icon="🎓" color="success" />
        <StatsCard label="Placement Rate" value={`${stats.placementRate}%`} icon="📈" color={stats.placementRate >= 50 ? "success" : "warning"} />
        <StatsCard label="Companies" value={stats.companies} icon="🏢" />
        <StatsCard label="Active Drives" value={stats.activeDrives} icon="🎯" />
        <StatsCard label="Applications" value={stats.applications} icon="📋" />
        <StatsCard label="Offers" value={stats.offers} icon="🏆" color="success" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-lg">
        {/* Active drives */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">Active Placement Drives</h2>
            <Link href="/placement-cell/drives" className="text-xs text-secondary hover:underline font-medium">View all →</Link>
          </div>
          <div className="divide-y divide-outline-variant">
            {stats.recentDrives.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No placement drives yet.</div>
            ) : (
              stats.recentDrives.map((d: any) => (
                <div key={d.id} className="px-lg py-md flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-on-surface">{d.job_role}</div>
                    <div className="text-xs text-outline">
                      {d.companies?.name} · {d.placement_applications?.[0]?.count ?? 0} applications
                    </div>
                  </div>
                  <StatusBadge status={d.status} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent applications */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Recent Applications</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {stats.recentApplications.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No applications yet.</div>
            ) : (
              stats.recentApplications.map((a: any) => (
                <div key={a.id} className="px-lg py-md flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-on-surface">{a.students?.profiles?.full_name || "—"}</div>
                    <div className="text-xs text-outline">
                      {a.placement_drives?.job_role} · {a.placement_drives?.companies?.name}
                    </div>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Recent notifications */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">Recent Notifications</h2>
          <Link href="/placement-cell/notifications" className="text-xs text-secondary hover:underline font-medium">Send new →</Link>
        </div>
        <div className="divide-y divide-outline-variant">
          {recentNotifications.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">No notifications sent yet.</div>
          ) : (
            recentNotifications.map((n: any) => (
              <div key={n.id} className="px-lg py-md">
                <div className="text-sm font-semibold text-on-surface">{n.title}</div>
                <div className="text-xs text-outline mt-xs">{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
