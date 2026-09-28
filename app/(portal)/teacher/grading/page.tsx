"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/modal";
import { saveMarks as saveMarksAction } from "./actions";
import type { Database } from "@/types/database";

type ExamType = Database["public"]["Tables"]["marks"]["Row"]["exam_type"];

export default function TeacherGrading() {
  const supabase = createClient();
  const [offerings, setOfferings] = useState<any[]>([]);
  const [selectedOffering, setSelectedOffering] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [examType, setExamType] = useState<ExamType>("internal_1");
  const [maxMarks, setMaxMarks] = useState("100");
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadOfferings(); }, []);

  const loadOfferings = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // Marks belong to a delivery, so the picker lists offerings. No
    // substitute path here, unlike attendance — covering one class does not
    // confer authority over a section's assessment record.
    const { data } = await supabase
      .from("course_offerings")
      .select("id, status, courses:course_id(id, name, code), sections:section_id(name), semesters:semester_id(name)")
      .eq("instructor_id", user.id);
    setOfferings(((data as any[]) || []).filter((o) => o.status !== "cancelled"));
  };

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
    setSelectedOffering(offeringId);
    if (!offeringId) {
      setStudents([]);
      setMarks({});
      return;
    }

    // Keyed by students.id end to end — course_enrollments.student_id now
    // references students(id) directly (047), so the profiles<->students
    // round trip this page used to make twice is gone.
    const { data: enrollments } = await supabase
      .from("course_enrollments")
      .select("student_id, students:student_id(id, enrollment_number, profiles:user_id(full_name))")
      .eq("offering_id", offeringId)
      .eq("status", "enrolled");

    const list = ((enrollments as any[]) || []).map((e) => ({
      id: e.student_id,
      full_name: e.students?.profiles?.full_name || "Unknown",
      enrollment_number: e.students?.enrollment_number || "",
    }));
    setStudents(list);

    const { data: existingMarks } = await supabase
      .from("marks")
      .select("student_id, obtained_marks")
      .eq("offering_id", offeringId)
      .eq("exam_type", examType)
      .in("student_id", list.map((s) => s.id));

    const m: Record<string, string> = {};
    ((existingMarks as any[]) || []).forEach((em) => {
      m[em.student_id] = String(em.obtained_marks);
    });
    setMarks(m);
  };

  const saveMarks = async () => {
    setLoading(true);
    setError(null);
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

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save marks.");
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

      {saved && (
        <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">
          ✅ Marks saved successfully!
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-md items-end">
        <div className="space-y-xs">
          <label htmlFor="grading-offering" className="text-xs font-semibold text-outline uppercase tracking-wider">Class</label>
          <select id="grading-offering" value={selectedOffering} onChange={(e) => loadStudents(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none min-w-[280px]">
            <option value="">Select class...</option>
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
        {selectedOffering && students.length > 0 && (
          <Button onClick={saveMarks} disabled={loading}>{loading ? "Saving..." : "Save Marks"}</Button>
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
        </div>
      )}
    </div>
  );
}
