"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { assignHod, listEligibleHodCandidates } from "./actions";

export default function DirectorDepartments() {
  const supabase = createClient();
  const [departments, setDepartments] = useState<any[]>([]);
  const [enrollmentByDept, setEnrollmentByDept] = useState<Record<string, any>>({});
  const [staff, setStaff] = useState<any[]>([]);
  const [editDept, setEditDept] = useState<any>(null);
  const [selectedHod, setSelectedHod] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [deptRes, enrollRes] = await Promise.all([
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
      supabase.from("mv_department_enrollment").select("*"),
    ]);
    setDepartments(deptRes.data || []);
    const byDept: Record<string, any> = {};
    (enrollRes.data || []).forEach((e: any) => { byDept[e.department_id] = e; });
    setEnrollmentByDept(byDept);
  };

  const loadStaff = async () => {
    setStaff(await listEligibleHodCandidates());
  };

  useEffect(() => { load(); loadStaff(); }, []);

  const openEdit = (dept: any) => {
    setEditDept(dept);
    setSelectedHod(dept.hod_id || "");
    setError(null);
  };

  const handleAssignHod = async () => {
    if (!editDept) return;
    setLoading(true);
    setError(null);
    try {
      await assignHod(editDept.id, selectedHod || null);
      setEditDept(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign HOD.");
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

      {error && !editDept && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
                <span className={`text-xs font-semibold px-sm py-xs rounded-full ${d.status === "active" ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}>{d.status}</span>
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

      <Modal
        open={!!editDept}
        onClose={() => setEditDept(null)}
        title={`Assign HOD — ${editDept?.name || ""}`}
        description="Only staff with the HOD or Teacher role are eligible."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditDept(null)}>Cancel</Button>
            <Button onClick={handleAssignHod} disabled={loading}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
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
