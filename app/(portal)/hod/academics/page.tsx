"use client";

import { useState } from "react";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { listMyDepartments } from "./actions";
import { TermTab } from "./term-tab";
import { StructureTab } from "./structure-tab";
import { OfferingsTab } from "./offerings-tab";
import { TimetableTab } from "./timetable-tab";
import { StudentsTab } from "./students-tab";

/**
 * The HOD's academic workspace (ACADEMIC_LIFECYCLE_CONTRACT.md, PR 1): the
 * department's term inside the college term, Class In-Charges, the
 * department's academic structure, teacher assignment, the timetable and the
 * students still waiting for a section.
 *
 * Everything here belongs to the DEPARTMENT, not to this HOD: a new HOD sees
 * and manages the same configuration without recreating any of it.
 */
const TABS = [
  { id: "term", label: "Term & In-Charges" },
  { id: "structure", label: "Structure" },
  { id: "offerings", label: "Teachers & offerings" },
  { id: "timetable", label: "Timetable" },
  { id: "students", label: "Unplaced students" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function HodAcademicsPage() {
  const departments = useAsyncResource(() => listMyDepartments(), []);
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("term");

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Academics</h1>
        <p className="mt-xs text-sm text-on-surface-variant">
          Run your department&apos;s term, its Class In-Charges, teacher assignments and timetable.
        </p>
      </div>

      <StateView
        state={departments}
        isEmpty={(d) => d.length === 0}
        loadingLabel="Loading your departments…"
        empty={{ title: "No department", description: "You are not assigned as the HOD of any department yet. The Director assigns HODs." }}
      >
        {(list) => {
          const departmentId = picked && list.some((d) => d.id === picked) ? picked : list[0].id;
          const department = list.find((d) => d.id === departmentId)!;
          return (
            <div className="space-y-lg">
              {list.length > 1 && (
                <div className="max-w-sm">
                  <label htmlFor="academics-department" className="block text-sm font-medium text-on-surface-variant">Department</label>
                  <select
                    id="academics-department"
                    value={departmentId}
                    onChange={(e) => setPicked(e.target.value)}
                    className="mt-xs w-full rounded-xl border border-border-control bg-surface-container-low px-md py-sm text-sm text-on-surface"
                  >
                    {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              )}

              <nav aria-label="Academics sections" className="flex flex-wrap gap-xs">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={`rounded-xl px-md py-sm text-sm font-semibold motion-feedback ${
                      tab === t.id ? "bg-secondary text-on-secondary" : "border border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>

              {tab === "term" && <TermTab key={departmentId} departmentId={departmentId} departmentName={department.name} />}
              {tab === "structure" && <StructureTab key={departmentId} departmentId={departmentId} />}
              {tab === "offerings" && <OfferingsTab key={departmentId} departmentId={departmentId} />}
              {tab === "timetable" && <TimetableTab key={departmentId} departmentId={departmentId} />}
              {tab === "students" && <StudentsTab key={departmentId} departmentId={departmentId} />}
            </div>
          );
        }}
      </StateView>
    </div>
  );
}
