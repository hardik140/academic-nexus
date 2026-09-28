"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError, SessionExpiredError } from "@/lib/feedback-error";
import { requireRows } from "@/lib/read-result";
import { saveMarks as saveMarksAction } from "./actions";
import type { Database } from "@/types/database";

type ExamType = Database["public"]["Tables"]["marks"]["Row"]["exam_type"];

export default function TeacherGrading() {
  const supabase = createClient();
  const [selectedOffering, setSelectedOffering] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [examType, setExamType] = useState<ExamType>("internal_1");
  const [maxMarks, setMaxMarks] = useState("100");
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  // The class's students: loading, loaded, or failed — never "none" when the read failed.
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState<unknown>(null);
  // The latest class picked: an earlier, slower load must not replace its students.
  const latestLoad = useRef(0);

  const offeringsResource = useAsyncResource(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new SessionExpiredError();
    // Marks belong to a delivery, so the picker lists offerings. No
    // substitute path here, unlike attendance — covering one class does not
    // confer authority over a section's assessment record.
    const rows = requireRows(
      await supabase
        .from("course_offerings")
        .select("id, status, courses:course_id(id, name, code), sections:section_id(name), semesters:semester_id(name)")
        .eq("instructor_id", user.id)
    );
    return (rows as any[]).filter((o) => o.status !== "cancelled");
  }, []);
  const offerings = offeringsResource.data ?? [];

  /** "CS301 — Data Structures · Section A · Fall 2026". */
  const offeringLabel = (o: any) =>
    [
      `${o.courses?.code || ""} — ${o.courses?.name || "Unknown course"}`.trim(),
      o.sections?.name ? `Section ${o.sections.name}` : null,
      o.semesters?.name || null,
    ]
      .filter(Boolean)
      .join(" · ");

  const loadStudents = async (offeringId: string) => {
    const load = ++latestLoad.current;
    setSelectedOffering(offeringId);
    // A result shown for one class is not a result for the next.
    setSuccess(null);
    setError(null);
    setStudents([]);
    setMarks({});
    setStudentsError(null);
    if (!offeringId) {
      setStudentsLoading(false);
      return;
    }

    setStudentsLoading(true);
    try {
      // Keyed by students.id end to end — course_enrollments.student_id now
      // references students(id) directly (047), so the profiles<->students
      // round trip this page used to make twice is gone.
      const enrollments = requireRows(
        await supabase
          .from("course_enrollments")
          .select("student_id, students:student_id(id, enrollment_number, profiles:user_id(full_name))")
          .eq("offering_id", offeringId)
          .eq("status", "enrolled")
      );

      const list = (enrollments as any[]).map((e) => ({
        id: e.student_id,
        full_name: e.students?.profiles?.full_name || "Unknown",
        enrollment_number: e.students?.enrollment_number || "",
      }));

      const existingMarks = requireRows(
        await supabase
          .from("marks")
          .select("student_id, obtained_marks")
          .eq("offering_id", offeringId)
          .eq("exam_type", examType)
          .in("student_id", list.map((s) => s.id))
      );

      const m: Record<string, string> = {};
      (existingMarks as any[]).forEach((em) => {
        m[em.student_id] = String(em.obtained_marks);
      });
      if (load !== latestLoad.current) return;
      setStudents(list);
      setMarks(m);
    } catch (e) {
      if (load === latestLoad.current) setStudentsError(e);
    } finally {
      if (load === latestLoad.current) setStudentsLoading(false);
    }
  };

  const saveMarks = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const entries = students
        .map((s) => ({ studentDbId: s.id, obtainedMarks: parseFloat(marks[s.id] ?? "") }))
        .filter((e) => !isNaN(e.obtainedMarks));

      await saveMarksAction({
        offeringId: selectedOffering,
        examType,
        maxMarks: parseFloat(maxMarks),
        entries,
      });

      // Stays until dismissed or the class changes: the record of what was saved.
      setSuccess(`Marks saved for ${entries.length} ${entries.length === 1 ? "student" : "students"}.`);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to save marks."));
    } finally {
      setLoading(false);
    }
  };

  const examTypes = [
    { value: "internal_1", label: "Internal 1" },
    { value: "internal_2", label: "Internal 2" },
    { value: "midterm", label: "Midterm" },
    { value: "final", label: "Final" },
    { value: "assignment", label: "Assignment" },
    { value: "lab", label: "Lab" },
    { value: "project", label: "Project" },
    { value: "viva", label: "Viva" },
  ];

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Grade Entry</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Enter and manage student exam scores</p>
      </div>

      <Alert tone="success" onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>

      <ErrorAlert error={error} />

      {offeringsResource.status === "error" && (
        <ErrorState
          {...classifyError(offeringsResource.error)}
          title="Your classes couldn't be loaded"
          onRetry={offeringsResource.reload}
          className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
        />
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-md items-end">
        <div className="space-y-xs">
          <label htmlFor="grading-offering" className="text-xs font-semibold text-outline uppercase tracking-wider">Class</label>
          <select id="grading-offering" value={selectedOffering} onChange={(e) => loadStudents(e.target.value)}
            disabled={offeringsResource.status !== "success"}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none min-w-[280px]">
            <option value="">{offeringsResource.status === "loading" ? "Loading classes…" : "Select class..."}</option>
            {offerings.map((o) => (<option key={o.id} value={o.id}>{offeringLabel(o)}</option>))}
          </select>
        </div>
        <div className="space-y-xs">
          <label htmlFor="grading-exam-type" className="text-xs font-semibold text-outline uppercase tracking-wider">Exam Type</label>
          <select id="grading-exam-type" value={examType} onChange={(e) => setExamType(e.target.value as ExamType)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none">
            {examTypes.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
          </select>
        </div>
        <div className="space-y-xs">
          <label htmlFor="grading-max-marks" className="text-xs font-semibold text-outline uppercase tracking-wider">Max Marks</label>
          <input id="grading-max-marks" type="number" value={maxMarks} onChange={(e) => setMaxMarks(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none w-24" />
        </div>
        {selectedOffering && !studentsLoading && !studentsError && students.length > 0 && (
          <Button onClick={saveMarks} disabled={loading} aria-busy={loading || undefined}>{loading ? "Saving..." : "Save Marks"}</Button>
        )}
      </div>

      {/* Marks Entry */}
      {selectedOffering && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">
              📝 Enter Marks — {examTypes.find(t => t.value === examType)?.label} (Max: {maxMarks})
            </h2>
          </div>
          {studentsLoading ? (
            <LoadingState label="Loading students…" />
          ) : studentsError ? (
            <ErrorState
              {...classifyError(studentsError)}
              title="The class list couldn't be loaded"
              onRetry={() => loadStudents(selectedOffering)}
            />
          ) : (
          <div className="divide-y divide-outline-variant">
            {students.map((s: any, i: number) => {
              const obtained = parseFloat(marks[s.id] || "0");
              const pct = obtained / parseFloat(maxMarks) * 100;
              return (
                <div key={s.id} className="flex items-center gap-md px-lg py-md hover:bg-surface-container-low transition-colors">
                  <span className="text-xs text-outline w-6 text-right">{i + 1}.</span>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-on-surface">{s.full_name}</div>
                  </div>
                  <input
                    type="number"
                    min="0"
                    max={maxMarks}
                    value={marks[s.id] || ""}
                    onChange={(e) => setMarks({ ...marks, [s.id]: e.target.value })}
                    placeholder="0"
                    className="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-sm text-center text-on-surface focus:ring-2 focus:ring-secondary outline-none"
                  />
                  <span className={`text-xs font-semibold w-12 text-right ${
                    pct >= 60 ? "text-success" : pct >= 40 ? "text-warning" : "text-error"
                  }`}>
                    {marks[s.id] ? `${pct.toFixed(0)}%` : "—"}
                  </span>
                </div>
              );
            })}
            {students.length === 0 && (
              <div className="p-xl text-center text-sm text-outline">Select a course to view enrolled students.</div>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
