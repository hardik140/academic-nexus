"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { SessionExpiredError } from "@/lib/feedback-error";
import { requireData, requireRows } from "@/lib/read-result";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { HealthGauge } from "@/components/charts/health-gauge";
import { sendAnnouncement, getDashboardStats, getCommandCenterData } from "./actions";

const AUDIENCES: { value: "all" | "staff" | "students"; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Staff (teachers, HODs, wardens, finance, admin)" },
  { value: "students", label: "Students" },
];

const SUB_SCORES: { key: "academic_score" | "fee_collection_score" | "placement_score" | "hostel_score" | "faculty_score"; label: string }[] = [
  { key: "academic_score", label: "Academic Health" },
  { key: "fee_collection_score", label: "Financial (Fee Collection)" },
  { key: "placement_score", label: "Placement Health" },
  { key: "hostel_score", label: "Hostel Health" },
  { key: "faculty_score", label: "Faculty Health" },
];
const NOT_TRACKED_SCORES = [
  { label: "Infrastructure Health", note: "No asset/equipment data model yet" },
  { label: "Compliance Health", note: "No accreditation tracking module yet" },
];

function scoreColorClass(score: number): string {
  if (score >= 75) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-error";
}

function trendFor(latest: number | null, baseline: number | null) {
  if (latest == null || baseline == null) return null;
  const delta = Math.round((latest - baseline) * 10) / 10;
  if (delta === 0) return null;
  return { delta, direction: delta > 0 ? "up" : "down" };
}

export default function DirectorDashboard() {
  const supabase = createClient();
  const [showAnnounce, setShowAnnounce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<{ title: string; message: string; audience: "all" | "staff" | "students" }>({
    title: "",
    message: "",
    audience: "all",
  });

  // Everything the Command Center shows. A failed load is an error, never
  // zero students and "No departments configured." (owner decision D5).
  const dashboard = useAsyncResource(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new SessionExpiredError();

    const [profileRes, stats, deptListRes, command] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      getDashboardStats(),
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
      getCommandCenterData(),
    ]);

    return {
      profile: requireData(profileRes) as any,
      stats,
      departments: requireRows(deptListRes) as any[],
      command: command as any,
    };
  }, []);
  const profile = dashboard.data?.profile ?? null;
  const stats = dashboard.data?.stats ?? { totalStudents: 0, totalFaculty: 0, totalDepartments: 0 };
  const departments = dashboard.data?.departments ?? [];
  const command = dashboard.data?.command ?? null;

  const openAnnounce = () => {
    setShowAnnounce(true);
    setError(null);
    setSuccess(null);
  };

  const handleSend = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await sendAnnouncement(form.title, form.message, form.audience);
      setForm({ title: "", message: "", audience: "all" });
      setShowAnnounce(false);
      setSuccess(`Announcement sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to send announcement."));
    } finally {
      setLoading(false);
    }
  };

  const latest = command?.latest;
  const baseline = command?.baseline;
  const completeness: Record<string, string> = latest?.data_completeness_flags || {};

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Command Center</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Director&apos;s 360° View • {profile?.full_name}</p>
        </div>
        <Button onClick={openAnnounce}>📢 Send Announcement</Button>
      </div>

      <Alert tone="success" onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>

      <StateView state={dashboard} isEmpty={() => false} loadingLabel="Loading the Command Center…" empty={{ title: "Nothing to show yet" }}>
        {() => (
          <>
      {/* What changed since last login */}
      {command && (
        <div className="bg-secondary/5 border border-secondary/20 rounded-2xl p-lg">
          <h2 className="text-sm font-bold text-on-surface mb-sm">📌 What Changed Since Your Last Visit</h2>
          {!command.priorViewedAt ? (
            <p className="text-sm text-on-surface-variant">This is your first visit to the Command Center — nothing to compare yet.</p>
          ) : !baseline ? (
            <p className="text-sm text-on-surface-variant">No snapshot was recorded before your last visit — nothing to compare yet.</p>
          ) : (
            <div className="flex flex-wrap gap-lg text-sm">
              {trendFor(latest?.overall_score, baseline?.overall_score) && (
                <span>
                  Overall health {trendFor(latest.overall_score, baseline.overall_score)!.direction === "up" ? "↑" : "↓"}{" "}
                  {Math.abs(trendFor(latest.overall_score, baseline.overall_score)!.delta)} pts
                </span>
              )}
              <span>
                {command.topRiskFlags.length} open risk flag{command.topRiskFlags.length === 1 ? "" : "s"}
              </span>
              <span>
                {command.topDecisions.length} decision{command.topDecisions.length === 1 ? "" : "s"} awaiting approval
              </span>
              {!trendFor(latest?.overall_score, baseline?.overall_score) && (
                <span className="text-outline">No material score change.</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Institution Health Score */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
        <h2 className="text-sm font-bold text-on-surface mb-md">Institution Health Score</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-lg items-center">
          <HealthGauge
            score={latest?.overall_score ?? null}
            contributingCount={SUB_SCORES.filter((s) => latest?.[s.key] != null).length}
            possibleCount={SUB_SCORES.length}
          />
          <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-md">
            {SUB_SCORES.map((s) => {
              const value = latest?.[s.key];
              const isMissing = value == null || completeness[s.key] === "insufficient_data";
              return (
                <div key={s.key} className="bg-surface-container-low rounded-xl p-md">
                  <div className="text-[11px] font-semibold text-outline uppercase tracking-wider mb-xs">{s.label}</div>
                  {isMissing ? (
                    <div className="text-sm text-outline">Insufficient data</div>
                  ) : (
                    <div className={`text-2xl font-extrabold ${scoreColorClass(value)}`}>{value}</div>
                  )}
                </div>
              );
            })}
            {NOT_TRACKED_SCORES.map((s) => (
              <div key={s.label} className="bg-surface-container-low rounded-xl p-md">
                <div className="text-[11px] font-semibold text-outline uppercase tracking-wider mb-xs">{s.label}</div>
                <div className="text-sm text-outline">Not tracked yet</div>
                <div className="text-[10px] text-outline mt-xs">{s.note}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Attention + Decisions summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-lg">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">🚨 Needs Attention</h2>
            <Link href="/director/attention" className="text-xs font-medium text-secondary hover:underline">
              View All →
            </Link>
          </div>
          <div className="divide-y divide-outline-variant">
            {command?.topRiskFlags?.length > 0 ? (
              command.topRiskFlags.map((f: any) => (
                <Link key={f.id} href={`/director/attention/${f.id}`} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
                  <span className="text-sm text-on-surface">{f.title}</span>
                  <StatusBadge status={f.severity} />
                </Link>
              ))
            ) : (
              <div className="p-xl text-center text-sm text-outline">No critical institutional risks detected.</div>
            )}
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">🗳️ Decisions Waiting</h2>
            <Link href="/director/decisions" className="text-xs font-medium text-secondary hover:underline">
              View All →
            </Link>
          </div>
          <div className="divide-y divide-outline-variant">
            {command?.topDecisions?.length > 0 ? (
              command.topDecisions.map((d: any) => (
                <Link key={d.id} href={`/director/decisions/${d.id}`} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
                  <span className="text-sm text-on-surface">{d.title}</span>
                  <StatusBadge status={d.urgency} />
                </Link>
              ))
            ) : (
              <div className="p-xl text-center text-sm text-outline">No decisions awaiting approval.</div>
            )}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-md">
        {[
          { label: "Total Enrollment", value: stats.totalStudents, icon: "🎓" },
          { label: "Faculty Strength", value: stats.totalFaculty, icon: "👨‍🏫" },
          { label: "Departments", value: stats.totalDepartments, icon: "🏢" },
        ].map((kpi) => (
          <div key={kpi.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">{kpi.label}</div>
            <div className="text-3xl font-extrabold text-on-surface">{kpi.value.toLocaleString()}</div>
            <span className="text-xl mt-sm inline-block">{kpi.icon}</span>
          </div>
        ))}
      </div>

      {/* Departments Table */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Department Overview</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Department</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Code</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">HOD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {departments && departments.length > 0 ? (
                departments.map((dept: any) => (
                  <tr key={dept.id} className="hover:bg-surface-container-low transition-colors">
                    <td className="px-lg py-md font-medium text-on-surface">{dept.name}</td>
                    <td className="px-lg py-md text-on-surface-variant">{dept.code}</td>
                    <td className="px-lg py-md text-on-surface-variant">{(dept.profiles as any)?.full_name || "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="px-lg py-xl text-center text-outline">
                    No departments configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
          </>
        )}
      </StateView>

      <Modal
        open={showAnnounce}
        onClose={() => setShowAnnounce(false)}
        title="Send Announcement"
        description="Broadcasts a notification to the selected audience."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowAnnounce(false)}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={loading || !form.title || !form.message} aria-busy={loading || undefined}>
              {loading ? "Sending..." : "Send"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField
            label="Audience"
            id="audience"
            type="select"
            value={form.audience}
            onChange={(v) => setForm({ ...form, audience: v as "all" | "staff" | "students" })}
            options={AUDIENCES}
            required
          />
          <FormField label="Title" id="title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="e.g. Campus Update" required />
          <FormField
            label="Message"
            id="message"
            type="textarea"
            value={form.message}
            onChange={(v) => setForm({ ...form, message: v })}
            placeholder="Write your announcement..."
            required
          />
        </div>
      </Modal>
    </div>
  );
}
