"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import { assignHod, listEligibleHodCandidates } from "./actions";

export default function DirectorDepartments() {
  const supabase = createClient();
  const [editDept, setEditDept] = useState<any>(null);
  const [selectedHod, setSelectedHod] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Departments with their enrollment. A failed load is an error, never
  // "No departments found." (owner decision D5).
  const departmentsResource = useAsyncResource(async () => {
    const [deptRes, enrollRes] = await Promise.all([
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
      supabase.from("mv_department_enrollment").select("*"),
    ]);
    const departments = requireRows(deptRes) as any[];
    const byDept: Record<string, any> = {};
    for (const e of requireRows(enrollRes)) if (e.department_id) byDept[e.department_id] = e;
    return { departments, byDept };
  }, []);
  const departments = departmentsResource.data?.departments ?? [];
  const enrollmentByDept = departmentsResource.data?.byDept ?? {};

  const staffResource = useAsyncResource(() => listEligibleHodCandidates(), []);
  const staff: any[] = staffResource.data ?? [];

  const openEdit = (dept: any) => {
    setEditDept(dept);
    setSelectedHod(dept.hod_id || "");
    setError(null);
  };

  const handleAssignHod = async () => {
    if (!editDept || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await assignHod(editDept.id, selectedHod || null);
      const hod = staff.find((s: any) => s.id === selectedHod);
      setNotice(hod ? `${hod.full_name} is now HOD of ${editDept.name}.` : `${editDept.name} no longer has a HOD.`);
      setEditDept(null);
      departmentsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to assign HOD."));
    } finally {
      setLoading(false);
    }
  };

  const hodOptions = [
    { value: "", label: "— No HOD assigned —" },
    ...staff.map((s: any) => ({ value: s.id, label: `${s.full_name} (${s.role})` })),
  ];

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Departments</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Institution-wide department overview</p>
        </div>
        <a href="/director/departments/performance" className="text-xs font-medium text-secondary hover:underline">
          Performance Heatmap →
        </a>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The assign dialog shows its own failure. */}
      <ErrorAlert error={!editDept ? error : null} />

      <StateView state={departmentsResource} isEmpty={() => false} loadingLabel="Loading departments…" empty={{ title: "No departments found" }}>
        {() => (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {departments.map((d: any) => {
          const e = enrollmentByDept[d.id];
          return (
            <button
              key={d.id}
              onClick={() => openEdit(d)}
              className="text-left bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md"
            >
              <div className="flex items-center justify-between mb-md">
                <span className="font-mono text-sm font-bold text-secondary">{d.code}</span>
                <span className={`text-xs font-semibold px-sm py-xs rounded-full ${d.status === "active" ? "bg-success-container text-on-success-container" : "bg-error-container text-on-error-container"}`}>{d.status}</span>
              </div>
              <h3 className="text-sm font-bold text-on-surface mb-xs">{d.name}</h3>
              <p className="text-xs text-outline mb-md">HOD: {(d.profiles as any)?.full_name || "Unassigned"}</p>
              <div className="grid grid-cols-2 gap-sm text-xs">
                <div>
                  <div className="text-outline uppercase tracking-wider">Students</div>
                  <div className="font-bold text-on-surface">{e?.total_students || 0}</div>
                </div>
                <div>
                  <div className="text-outline uppercase tracking-wider">Avg CGPA</div>
                  <div className="font-bold text-on-surface">{e?.avg_cgpa || "—"}</div>
                </div>
              </div>
              <div className="mt-md text-xs font-medium text-secondary">Assign HOD →</div>
            </button>
          );
        })}
        {departments.length === 0 && (
          <div className="col-span-full p-xl text-center text-sm text-outline bg-surface-container-lowest border border-outline-variant rounded-2xl">
            No departments found.
          </div>
        )}
      </div>
        )}
      </StateView>

      <Modal
        open={!!editDept}
        onClose={() => setEditDept(null)}
        title={`Assign HOD — ${editDept?.name || ""}`}
        description="Only staff with the HOD or Teacher role are eligible."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditDept(null)}>Cancel</Button>
            <Button onClick={handleAssignHod} disabled={loading || staffResource.status !== "success"} aria-busy={loading || undefined}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <Alert
          tone="error"
          className="mb-md"
          action={<Button variant="outline" size="sm" onClick={staffResource.reload}>Try again</Button>}
        >
          {staffResource.status === "error" ? (
            <>
              Eligible staff couldn&apos;t be loaded, so a HOD can&apos;t be chosen yet.
            </>
          ) : null}
        </Alert>
        <FormField
          label="Head of Department"
          id="edit_hod"
          type="select"
          value={selectedHod}
          onChange={setSelectedHod}
          options={hodOptions}
        />
      </Modal>
    </div>
  );
}
