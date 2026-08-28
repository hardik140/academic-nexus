"use client";

import { useState, useEffect } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { listSubstitutionNeeds, listDepartmentTeachers, assignSubstitute } from "./actions";

export default function HodSubstitutions() {
  const [needed, setNeeded] = useState<any[]>([]);
  const [assigned, setAssigned] = useState<any[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [{ needed, assigned }, teacherList] = await Promise.all([
      listSubstitutionNeeds(),
      listDepartmentTeachers(),
    ]);
    setNeeded(needed);
    setAssigned(assigned);
    setTeachers(teacherList);
  };

  const handleAssign = async (id: string) => {
    const substituteTeacherId = picked[id];
    if (!substituteTeacherId) return;
    setLoading(id);
    setError(null);
    try {
      await assignSubstitute(id, substituteTeacherId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign substitute.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Substitution Management</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Classes affected by approved leave that need a covering teacher assigned
        </p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Needed — awaiting assignment */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔴 Needs a Substitute ({needed.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {needed.length > 0 ? needed.map((row: any) => {
            const availableTeachers = teachers.filter((t) => t.id !== row.original_teacher_id);
            return (
              <div key={row.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
                <div className="flex items-start justify-between gap-md flex-wrap">
                  <div>
                    <div className="text-sm font-semibold text-on-surface">
                      {(row.courses as any)?.code} — {(row.courses as any)?.name}
                    </div>
                    <div className="text-xs text-outline mt-xs">
                      {new Date(row.date).toLocaleDateString()} · Originally {(row.original as any)?.full_name}
                    </div>
                  </div>
                  <div className="flex gap-sm items-center shrink-0">
                    <select
                      value={picked[row.id] || ""}
                      onChange={(e) => setPicked({ ...picked, [row.id]: e.target.value })}
                      className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-xs text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
                    >
                      <option value="">Select substitute...</option>
                      {availableTeachers.map((t) => (
                        <option key={t.id} value={t.id}>{t.full_name}</option>
                      ))}
                    </select>
                    <Button size="sm" onClick={() => handleAssign(row.id)} disabled={!picked[row.id] || loading === row.id}>
                      {loading === row.id ? "..." : "Assign"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          }) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No unassigned substitution requirements.</div>
          )}
        </div>
      </div>

      {/* Assigned */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Assigned ({assigned.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {assigned.map((row: any) => (
            <div key={row.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm text-on-surface">
                  {(row.courses as any)?.code} — {new Date(row.date).toLocaleDateString()}
                </div>
                <div className="text-xs text-outline mt-xs">
                  {(row.original as any)?.full_name} → {(row.substitute as any)?.full_name}
                </div>
              </div>
              <StatusBadge status="assigned" />
            </div>
          ))}
          {assigned.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No substitutions assigned yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
