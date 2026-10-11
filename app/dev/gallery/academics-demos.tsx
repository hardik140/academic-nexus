"use client";

import { useState } from "react";
import { DepartmentTermPanel } from "@/components/academics/department-term-panel";
import { ReadinessChecklist } from "@/components/academics/readiness-checklist";
import { ClassInchargeTable } from "@/components/academics/class-incharge-table";
import { AcademicContextCard } from "@/components/academics/academic-context-card";
import { StudentInviteForm } from "@/components/academics/student-invite-form";
import { TimetableWeek } from "@/components/academics/timetable-week";
import type { AcademicContext, DepartmentReadiness, SectionWithIncharge, StaffOption, TimetableSlotRow } from "@/lib/academic/types";

/**
 * Development gallery: the academic foundation (migration 055). Fictional
 * data only — the real pages read the database, which browser tests may not
 * touch (owner decision D3).
 */

const NOT_READY: DepartmentReadiness = {
  semester_id: "5e000000-0000-4000-8000-000000000003",
  semester_name: "Fall 2026",
  status: "not_started",
  ready: false,
  blocking_count: 2,
  pending_count: 1,
  items: [
    { code: "section_without_incharge", severity: "blocking", message: "BTECH-CSE B (2024) has no Class In-Charge this term.", ref_id: "s2" },
    { code: "section_without_offerings", severity: "blocking", message: "BTECH-CSE A (2023) has no course offering this term.", ref_id: "s3" },
    { code: "offering_without_instructor", severity: "pending", message: "CS302 (A) has no teacher assigned.", ref_id: "o1" },
  ],
};
const READY_PENDING: DepartmentReadiness = {
  ...NOT_READY,
  ready: true,
  blocking_count: 0,
  items: NOT_READY.items.filter((i) => i.severity === "pending"),
};
const RUNNING: DepartmentReadiness = { ...NOT_READY, status: "active", ready: true, blocking_count: 0, pending_count: 0, items: [], started_at: "2026-07-01T04:00:00Z" };

const SECTIONS: SectionWithIncharge[] = [
  { id: "s1", name: "A", batch_year: 2024, status: "active", programme_code: "BTECH-CSE", programme_name: "B.Tech Computer Science", student_count: 58, incharge: { id: "t1", full_name: "Rahul Sharma" } },
  { id: "s2", name: "B", batch_year: 2024, status: "active", programme_code: "BTECH-CSE", programme_name: "B.Tech Computer Science", student_count: 55, incharge: null },
];
const STAFF: StaffOption[] = [
  { id: "t1", full_name: "Rahul Sharma" },
  { id: "t2", full_name: "Priya Nair" },
  { id: "t3", full_name: "Anand Rao" },
];

const STUDENT_CONTEXT: AcademicContext = {
  role: "student",
  term: { id: "t", name: "Fall 2026", start_date: "2026-07-01", end_date: "2026-11-30", academic_year: "2026-27" },
  student: { id: "st", enrollment_number: "2024CSE014", programme_semester: 5, status: "active", department: { id: "d", name: "Computer Science" } },
  section: {
    id: "s1", name: "A", batch_year: 2024,
    programme: { id: "p", name: "B.Tech Computer Science", code: "BTECH-CSE" },
    year_of_study: 3,
    class_incharge: { id: "t1", full_name: "Rahul Sharma" },
  },
  department_term: "active",
  offering_ids: [],
};
const UNPLACED_CONTEXT: AcademicContext = { ...STUDENT_CONTEXT, section: null };

const SLOTS: TimetableSlotRow[] = [
  { id: "sl1", offering_id: "o1", day_of_week: 1, start_time: "09:00:00", end_time: "10:00:00", room: "R-101", label: "CS301 · BTECH-CSE A (2024)", teacher: "Rahul Sharma" },
  { id: "sl2", offering_id: "o2", day_of_week: 1, start_time: "10:00:00", end_time: "11:00:00", room: null, label: "CS302 · BTECH-CSE B (2024)", teacher: null },
  { id: "sl3", offering_id: "o3", day_of_week: 3, start_time: "14:00:00", end_time: "15:30:00", room: "Lab 2", label: "CS305 · BTECH-CSE A (2024)", teacher: "Priya Nair" },
];

export function DepartmentTermDemos() {
  const [log, setLog] = useState("No action yet.");
  return (
    <div className="space-y-lg">
      <p data-testid="academics-log" className="text-xs text-on-surface-variant">{log}</p>
      <div className="grid gap-md lg:grid-cols-2">
        <div data-testid="term-not-ready">
          <DepartmentTermPanel departmentName="Computer Science" readiness={NOT_READY} onStart={() => { setLog("start: not-ready"); return true; }} onEnd={() => true} />
        </div>
        <div data-testid="term-pending">
          <DepartmentTermPanel departmentName="Computer Science" readiness={READY_PENDING} onStart={(ack) => { setLog(`start: acknowledged=${ack}`); return true; }} onEnd={() => true} />
        </div>
        <div data-testid="term-running">
          <DepartmentTermPanel departmentName="Computer Science" readiness={RUNNING} onStart={() => true} onEnd={(reason) => { setLog(`end: ${reason}`); return true; }} />
        </div>
        <div data-testid="term-error">
          <DepartmentTermPanel
            departmentName="Computer Science"
            readiness={RUNNING}
            error="Only the HOD of this department can end its term."
            onStart={() => true}
            onEnd={() => false}
          />
        </div>
      </div>
      <div data-testid="readiness-clear-demo">
        <ReadinessChecklist readiness={{ ...RUNNING, status: "not_started" }} />
      </div>
    </div>
  );
}

export function ClassInchargeDemos() {
  const [log, setLog] = useState("No assignment yet.");
  return (
    <div className="space-y-md">
      <p data-testid="incharge-log" className="text-xs text-on-surface-variant">{log}</p>
      <ClassInchargeTable sections={SECTIONS} staff={STAFF} onAssign={(s, t) => setLog(`assign ${t} to ${s}`)} />
    </div>
  );
}

export function AcademicContextDemos() {
  return (
    <div className="grid gap-md lg:grid-cols-2">
      <div data-testid="context-placed"><AcademicContextCard context={STUDENT_CONTEXT} /></div>
      <div data-testid="context-unplaced"><AcademicContextCard context={UNPLACED_CONTEXT} /></div>
    </div>
  );
}

export function StudentInviteDemos() {
  const [log, setLog] = useState("No invitation yet.");
  return (
    <div className="space-y-md">
      <p data-testid="invite-log" className="text-xs text-on-surface-variant">{log}</p>
      <div className="grid gap-md lg:grid-cols-2">
        <div data-testid="invite-choose-section" className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg">
          <StudentInviteForm
            idPrefix="demo-hod-invite"
            sections={[{ id: "s1", label: "BTECH-CSE A (2024)" }, { id: "s2", label: "BTECH-CSE B (2024)" }]}
            maxSemester={8}
            onSubmit={(v) => setLog(`invite ${v.email} to ${v.sectionId}, semester ${v.programmeSemester}`)}
          />
        </div>
        <div data-testid="invite-fixed-section" className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg">
          <StudentInviteForm
            idPrefix="demo-incharge-invite"
            sections={[{ id: "s1", label: "BTECH-CSE A (2024)" }]}
            maxSemester={8}
            error="That enrollment number is already in use."
            onSubmit={(v) => setLog(`invite ${v.email} to ${v.sectionId}`)}
          />
        </div>
      </div>
    </div>
  );
}

export function TimetableWeekDemos() {
  const [log, setLog] = useState("No change yet.");
  return (
    <div className="space-y-md">
      <p data-testid="timetable-log" className="text-xs text-on-surface-variant">{log}</p>
      <TimetableWeek slots={SLOTS} onRemove={(id) => setLog(`remove ${id}`)} />
      <div data-testid="timetable-empty"><TimetableWeek slots={[]} /></div>
    </div>
  );
}
