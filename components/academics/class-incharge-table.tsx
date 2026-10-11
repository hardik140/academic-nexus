"use client";

import { useState } from "react";
import { Button } from "@/components/ui/modal";
import type { SectionWithIncharge, StaffOption } from "@/lib/academic/types";

/**
 * Class In-Charge per section for the active term (055 §10). The relationship
 * is explicit: teaching a section never makes anyone its In-Charge.
 * Replacing one keeps the previous assignment as history.
 *
 * Presentational: the caller performs the assignment and reloads.
 */
export function ClassInchargeTable({
  sections,
  staff,
  onAssign,
  pendingSectionId,
  disabled,
}: {
  sections: SectionWithIncharge[];
  staff: StaffOption[];
  onAssign: (sectionId: string, teacherId: string) => void;
  pendingSectionId?: string | null;
  disabled?: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});

  if (sections.length === 0) {
    return <p className="text-sm text-on-surface-variant">This department has no active section. Add one under Structure.</p>;
  }

  return (
    <div className="overflow-x-auto" data-testid="class-incharge-table">
      <table className="w-full text-sm">
        <caption className="sr-only">Class In-Charge of each section this term</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-on-surface-variant">
            <th scope="col" className="px-md py-sm">Section</th>
            <th scope="col" className="px-md py-sm">Students</th>
            <th scope="col" className="px-md py-sm">Class In-Charge</th>
            <th scope="col" className="px-md py-sm"><span className="sr-only">Change</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-variant">
          {sections.map((s) => {
            const label = `${s.programme_code} ${s.name} (${s.batch_year})`;
            const choice = picked[s.id] ?? "";
            const selectId = `incharge-${s.id}`;
            return (
              <tr key={s.id}>
                <th scope="row" className="px-md py-sm text-left font-semibold text-on-surface">{label}</th>
                <td className="px-md py-sm text-on-surface-variant">{s.student_count}</td>
                <td className="px-md py-sm">
                  {s.incharge ? (
                    <span className="text-on-surface">{s.incharge.full_name}</span>
                  ) : (
                    <span className="font-semibold text-error">Not assigned</span>
                  )}
                </td>
                <td className="px-md py-sm">
                  <div className="flex flex-wrap items-center gap-sm">
                    <label htmlFor={selectId} className="sr-only">New Class In-Charge for {label}</label>
                    <select
                      id={selectId}
                      value={choice}
                      onChange={(e) => setPicked({ ...picked, [s.id]: e.target.value })}
                      disabled={disabled}
                      className="rounded-xl border border-border-control bg-surface-container-low px-md py-xs text-sm text-on-surface"
                    >
                      <option value="">Choose a teacher…</option>
                      {staff.filter((t) => t.id !== s.incharge?.id).map((t) => (
                        <option key={t.id} value={t.id}>{t.full_name}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!choice || disabled || pendingSectionId === s.id}
                      aria-busy={pendingSectionId === s.id || undefined}
                      onClick={() => onAssign(s.id, choice)}
                    >
                      {pendingSectionId === s.id ? "Saving…" : s.incharge ? "Replace" : "Assign"}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
