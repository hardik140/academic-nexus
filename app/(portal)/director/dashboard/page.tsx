"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { sendAnnouncement, getDashboardStats } from "./actions";

const AUDIENCES: { value: "all" | "staff" | "students"; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Staff (teachers, HODs, wardens, finance, admin)" },
  { value: "students", label: "Students" },
];

export default function DirectorDashboard() {
  const supabase = createClient();
  const [profile, setProfile] = useState<any>(null);
  const [stats, setStats] = useState({ totalStudents: 0, totalFaculty: 0, totalDepartments: 0 });
  const [departments, setDepartments] = useState<any[]>([]);
  const [showAnnounce, setShowAnnounce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<{ title: string; message: string; audience: "all" | "staff" | "students" }>({
    title: "",
    message: "",
    audience: "all",
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [profileRes, statsResult, deptListRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      getDashboardStats(),
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
    ]);

    setProfile(profileRes.data);
    setStats(statsResult);
    setDepartments(deptListRes.data || []);
  };

  const openAnnounce = () => {
    setShowAnnounce(true);
    setError(null);
    setSuccess(null);
  };

  const handleSend = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await sendAnnouncement(form.title, form.message, form.audience);
      setForm({ title: "", message: "", audience: "all" });
      setShowAnnounce(false);
      setSuccess(`Announcement sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send announcement.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
            Institutional Overview
          </h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Director&apos;s 360° View • {profile?.full_name}
          </p>
        </div>
        <Button onClick={openAnnounce}>📢 Send Announcement</Button>
      </div>

      {success && (
        <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">{success}</div>
      )}

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
              {departments && departments.length > 0 ? departments.map((dept: any) => (
                <tr key={dept.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-medium text-on-surface">{dept.name}</td>
                  <td className="px-lg py-md text-on-surface-variant">{dept.code}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(dept.profiles as any)?.full_name || "—"}</td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="px-lg py-xl text-center text-outline">No departments configured.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={showAnnounce}
        onClose={() => setShowAnnounce(false)}
        title="Send Announcement"
        description="Broadcasts a notification to the selected audience."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowAnnounce(false)}>Cancel</Button>
            <Button onClick={handleSend} disabled={loading || !form.title || !form.message}>{loading ? "Sending..." : "Send"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Audience" id="audience" type="select" value={form.audience} onChange={(v) => setForm({ ...form, audience: v as "all" | "staff" | "students" })} options={AUDIENCES} required />
          <FormField label="Title" id="title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="e.g. Campus Update" required />
          <FormField label="Message" id="message" type="textarea" value={form.message} onChange={(v) => setForm({ ...form, message: v })} placeholder="Write your announcement..." required />
        </div>
      </Modal>
    </div>
  );
}
