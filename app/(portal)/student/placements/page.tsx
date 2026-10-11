"use client";

import { useState } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
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
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Everything on the four tabs. A failed load is an error, never "No
  // eligible placement opportunities right now." (owner decision D5).
  const placements = useAsyncResource(async () => {
    const [opportunities, applications, notifications, profile] = await Promise.all([
      listOpportunities(),
      listMyApplications(),
      listMyPlacementNotifications(),
      getMyPlacementProfile(),
    ]);
    return {
      opportunities: opportunities as any[],
      applications: applications as any[],
      notifications: notifications as any[],
      profile: profile as any,
    };
  }, []);
  const opportunities = placements.data?.opportunities ?? [];
  const applications = placements.data?.applications ?? [];
  const notifications = placements.data?.notifications ?? [];
  const profile = placements.data?.profile ?? null;

  const handleApply = async (driveId: string) => {
    // One application per click.
    if (applyingId) return;
    setApplyingId(driveId);
    setError(null);
    setSuccess(null);
    try {
      await applyToDrive(driveId);
      const drive = opportunities.find((d) => d.id === driveId);
      setSuccess(drive ? `Application to ${drive.companies?.name ?? "the company"} for ${drive.job_role} submitted.` : "Application submitted.");
      // Refreshing is not part of applying: its failure shows on the tabs.
      placements.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to apply."));
    } finally {
      setApplyingId(null);
    }
  };

  const placementStatus = profile?.student_placement_profiles?.placement_status || "not_placed";

  return (
    <div className="space-y-lg">
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

      <ErrorAlert error={error} />
      <Alert tone="success" onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>

      <StateView state={placements} isEmpty={() => false} loadingLabel="Loading placements…" empty={{ title: "Nothing here yet" }}>
        {() => (
          <>
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
                  <Button size="sm" onClick={() => handleApply(d.id)} disabled={applyingId !== null} aria-busy={applyingId === d.id || undefined}>
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
          </>
        )}
      </StateView>
    </div>
  );
}
