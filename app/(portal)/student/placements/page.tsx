"use client";

import { useState, useEffect } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import {
  listOpportunities,
  applyToDrive,
  listMyApplications,
  getMyPlacementProfile,
  listMyPlacementNotifications,
} from "./actions";

type Tab = "opportunities" | "applications" | "notifications" | "profile";

const TABS: { value: Tab; label: string }[] = [
  { value: "opportunities", label: "Opportunities" },
  { value: "applications", label: "My Applications" },
  { value: "notifications", label: "Notifications" },
  { value: "profile", label: "My Profile" },
];

export default function StudentPlacements() {
  const [tab, setTab] = useState<Tab>("opportunities");
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [applications, setApplications] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [profile, setProfile] = useState<any>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadAll = async () => {
    const [opps, apps, notifs, prof] = await Promise.all([
      listOpportunities(),
      listMyApplications(),
      listMyPlacementNotifications(),
      getMyPlacementProfile(),
    ]);
    setOpportunities(opps);
    setApplications(apps);
    setNotifications(notifs);
    setProfile(prof);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleApply = async (driveId: string) => {
    setApplyingId(driveId);
    setError(null);
    setSuccess(null);
    try {
      await applyToDrive(driveId);
      setSuccess("Application submitted.");
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply.");
    } finally {
      setApplyingId(null);
    }
  };

  const placementStatus = profile?.student_placement_profiles?.placement_status || "not_placed";

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placement</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Opportunities, applications, and your placement status</p>
      </div>

      <div className="flex gap-xs bg-surface-container-low rounded-xl p-xs w-fit overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`text-xs font-semibold px-md py-sm rounded-lg transition-colors whitespace-nowrap ${
              tab === t.value ? "bg-secondary text-on-secondary" : "text-on-surface-variant"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}
      {success && (
        <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">{success}</div>
      )}

      {tab === "opportunities" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
          {opportunities.length === 0 ? (
            <div className="md:col-span-2 p-xl text-center text-sm text-outline bg-surface-container-lowest border border-outline-variant rounded-2xl">
              No eligible placement opportunities right now.
            </div>
          ) : (
            opportunities.map((d: any) => (
              <div key={d.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
                <div className="flex items-center justify-between mb-sm">
                  <h3 className="text-sm font-bold text-on-surface">{d.job_role}</h3>
                  {d.package_lpa && <span className="text-xs font-semibold text-success">₹{d.package_lpa}L</span>}
                </div>
                <p className="text-xs text-outline mb-md">
                  {d.companies?.name} {d.companies?.location ? `· ${d.companies.location}` : ""}
                </p>
                <div className="text-xs text-on-surface-variant mb-md">
                  Deadline: {new Date(d.application_deadline).toLocaleDateString()}
                </div>
                {d.applicationStatus ? (
                  <StatusBadge status={d.applicationStatus} />
                ) : (
                  <Button size="sm" onClick={() => handleApply(d.id)} disabled={applyingId === d.id}>
                    {applyingId === d.id ? "Applying..." : "Apply"}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === "applications" && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="divide-y divide-outline-variant">
            {applications.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No applications yet.</div>
            ) : (
              applications.map((a: any) => (
                <div key={a.id} className="px-lg py-md flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-on-surface">{a.placement_drives?.companies?.name}</div>
                    <div className="text-xs text-outline">
                      {a.placement_drives?.job_role} · Applied {new Date(a.applied_at).toLocaleDateString()}
                    </div>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === "notifications" && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="divide-y divide-outline-variant">
            {notifications.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No placement notifications yet.</div>
            ) : (
              notifications.map((n: any) => (
                <div key={n.id} className="px-lg py-md">
                  <div className="text-sm font-semibold text-on-surface">{n.title}</div>
                  <div className="text-xs text-on-surface-variant mt-xs">{n.message}</div>
                  <div className="text-[11px] text-outline mt-xs">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === "profile" && profile && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
            <div>
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Enrollment No.</div>
              <div className="text-sm font-bold text-on-surface">{profile.enrollment_number}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Department</div>
              <div className="text-sm font-bold text-on-surface">{profile.departments?.name || "—"}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">CGPA</div>
              <div className="text-sm font-bold text-on-surface">{profile.cgpa ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Batch Year</div>
              <div className="text-sm font-bold text-on-surface">{profile.batch_year}</div>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Placement Status</div>
            <StatusBadge status={placementStatus} />
          </div>
        </div>
      )}
    </div>
  );
}
