"use client";

import { useMemo, useState } from "react";
import { formatPct } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/modal";
import { projectAttendance, type EnrolledSubjectRisk, type DegreeProgressResult } from "@/lib/academic-scoring";

interface AttendanceCourseOption {
  courseId: string;
  courseName: string;
  present: number;
  total: number;
}

interface StudentInsightsClientProps {
  subjectRisks: EnrolledSubjectRisk[];
  degreeProgress: DegreeProgressResult;
  attendanceByCourse: AttendanceCourseOption[];
  overallAttendance: { present: number; total: number };
}

type Tab = "risk" | "degree" | "forecast";

const TABS: { value: Tab; label: string }[] = [
  { value: "risk", label: "Risk Radar" },
  { value: "degree", label: "Degree Progress" },
  { value: "forecast", label: "Attendance Forecast" },
];

const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  elective: "Elective",
  lab: "Lab",
  project: "Project",
  seminar: "Seminar",
};

export function StudentInsightsClient({
  subjectRisks,
  degreeProgress,
  attendanceByCourse,
  overallAttendance,
}: StudentInsightsClientProps) {
  const [tab, setTab] = useState<Tab>("risk");
  const [selectedCourse, setSelectedCourse] = useState("all");
  const [nextClasses, setNextClasses] = useState(5);
  const [attendRatePct, setAttendRatePct] = useState(100);

  const forecastBase = selectedCourse === "all"
    ? overallAttendance
    : attendanceByCourse.find((c) => c.courseId === selectedCourse) || overallAttendance;

  const projection = useMemo(
    () =>
      projectAttendance({
        present: forecastBase.present,
        total: forecastBase.total,
        nextClasses,
        attendRate: attendRatePct / 100,
      }),
    [forecastBase.present, forecastBase.total, nextClasses, attendRatePct]
  );
  const currentPct = forecastBase.total > 0 ? (forecastBase.present / forecastBase.total) * 100 : null;

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Academic Intelligence</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Risk, degree progress, and attendance projections — all computed from your own records</p>
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

      {tab === "risk" && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="divide-y divide-outline-variant">
            {subjectRisks.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No active course enrollments to assess yet.</div>
            ) : (
              subjectRisks.map((r) => (
                <div key={r.course?.id} className="px-lg py-md">
                  <div className="flex items-center gap-sm mb-xs">
                    <StatusBadge status={r.risk.level} />
                    <span className="text-sm font-semibold text-on-surface">{r.course?.name || "Course"}</span>
                    <span className="text-xs text-outline">{r.course?.code}</span>
                  </div>
                  {r.risk.reasons.length > 0 ? (
                    r.risk.reasons.map((reason, i) => (
                      <div key={i} className="text-xs text-on-surface-variant mt-xs">{reason}</div>
                    ))
                  ) : (
                    <div className="text-xs text-outline mt-xs">On track — no risk signals.</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === "degree" && (
        <div className="space-y-md">
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Overall Credits</div>
            <div className="text-3xl font-extrabold text-on-surface">
              {degreeProgress.creditsCompleted} <span className="text-base font-medium text-outline">/ {degreeProgress.creditsRequired}</span>
            </div>
            <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
              <div
                className="h-full bg-info rounded-full transition-all duration-700"
                style={{ width: `${Math.min((degreeProgress.creditsCompleted / degreeProgress.creditsRequired) * 100, 100)}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
            {Object.entries(degreeProgress.byCategory).map(([type, bucket]) => (
              <div key={type} className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
                <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-md">{CATEGORY_LABELS[type] || type}</div>
                <div className="grid grid-cols-3 gap-sm text-center">
                  <div>
                    <div className="text-lg font-bold text-success">{bucket.completed}</div>
                    <div className="text-[10px] text-outline">Completed</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-info">{bucket.inProgress}</div>
                    <div className="text-[10px] text-outline">In Progress</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-error">{bucket.blocked}</div>
                    <div className="text-[10px] text-outline">Blocked</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "forecast" && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-lg max-w-[36rem]">
          <div>
            <label htmlFor="forecast-course-select" className="text-xs font-semibold text-outline uppercase tracking-wider block mb-xs">Course</label>
            <select
              id="forecast-course-select"
              value={selectedCourse}
              onChange={(e) => setSelectedCourse(e.target.value)}
              className="w-full bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface"
            >
              <option value="all">All courses ({overallAttendance.present}/{overallAttendance.total})</option>
              {attendanceByCourse.map((c) => (
                <option key={c.courseId} value={c.courseId}>
                  {c.courseName} ({c.present}/{c.total})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-outline uppercase tracking-wider block mb-xs">
              Next {nextClasses} class{nextClasses !== 1 ? "es" : ""}
            </label>
            <input
              type="range"
              min={0}
              max={20}
              value={nextClasses}
              onChange={(e) => setNextClasses(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-outline uppercase tracking-wider block mb-xs">
              Attendance rate for those classes: {attendRatePct}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              step={10}
              value={attendRatePct}
              onChange={(e) => setAttendRatePct(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="pt-md border-t border-outline-variant flex items-center justify-between">
            <div>
              <div className="text-xs text-outline">Current</div>
              <div className="text-2xl font-extrabold text-on-surface">
                {currentPct != null ? formatPct(currentPct, 1) : "—"}
              </div>
            </div>
            <div className="text-2xl text-outline">→</div>
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">{projection.label}</div>
              <div className={`text-2xl font-extrabold ${projection.projectedPct != null && projection.projectedPct < 75 ? "text-error" : "text-success"}`}>
                {projection.projectedPct != null ? formatPct(projection.projectedPct, 1) : "—"}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-outline">
            This is a projection based on your current attendance record, not a guarantee — actual future classes may be marked differently.
          </p>
        </div>
      )}
    </div>
  );
}
