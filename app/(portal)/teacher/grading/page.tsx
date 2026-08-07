"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/modal";
import { saveMarks as saveMarksAction } from "./actions";
import type { Database } from "@/types/database";

type ExamType = Database["public"]["Tables"]["marks"]["Row"]["exam_type"];

export default function TeacherGrading() {
  const supabase = createClient();
  const [courses, setCourses] = useState<any[]>([]);
  const [selectedCourse, setSelectedCourse] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [examType, setExamType] = useState<ExamType>("internal_1");
  const [maxMarks, setMaxMarks] = useState("100");
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadCourses(); }, []);

  const loadCourses = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("courses").select("id, name, code").eq("instructor_id", user.id);
    setCourses(data || []);
  };

  const loadStudents = async (courseId: string) => {
    setSelectedCourse(courseId);
    const { data: enrollments } = await supabase
      .from("course_enrollments")
      .select("student_id, profiles:student_id(id, full_name)")
      .eq("course_id", courseId)
      .eq("status", "enrolled");

    const list = (enrollments || []).map((e: any) => ({
      id: e.student_id,
      full_name: (e.profiles as any)?.full_name || "Unknown",
    }));
    setStudents(list);

    // Load existing marks
    const studentUserIds = list.map((s: any) => s.id);
    const { data: studentRecords } = await supabase
      .from("students")
      .select("id, user_id")
      .in("user_id", studentUserIds);

    const studentDbIds = (studentRecords || []).map(s => s.id);
    const { data: existingMarks } = await supabase
      .from("marks")
      .select("student_id, obtained_marks")
      .eq("course_id", courseId)
      .eq("exam_type", examType)
      .in("student_id", studentDbIds);

    const m: Record<string, string> = {};
    (existingMarks || []).forEach((em: any) => {
      const userRec = (studentRecords || []).find(s => s.id === em.student_id);
      if (userRec) m[userRec.user_id] = String(em.obtained_marks);
    });
    setMarks(m);
  };

  const saveMarks = async () => {
    setLoading(true);
    setError(null);
    try {
      const studentUserIds = Object.keys(marks);
      const { data: studentRecords } = await supabase
        .from("students")
        .select("id, user_id")
        .in("user_id", studentUserIds);

      const entries = (studentRecords || [])
        .map((s) => ({ studentDbId: s.id, obtainedMarks: parseFloat(marks[s.user_id] || "0") }))
        .filter((e) => !isNaN(e.obtainedMarks));

      await saveMarksAction({
        courseId: selectedCourse,
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
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
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
          <label className="text-xs font-semibold text-outline uppercase tracking-wider">Course</label>
          <select value={selectedCourse} onChange={(e) => loadStudents(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none min-w-[200px]">
            <option value="">Select course...</option>
            {courses.map((c) => (<option key={c.id} value={c.id}>{c.code} — {c.name}</option>))}
          </select>
        </div>
        <div className="space-y-xs">
          <label className="text-xs font-semibold text-outline uppercase tracking-wider">Exam Type</label>
          <select value={examType} onChange={(e) => setExamType(e.target.value as ExamType)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none">
            {examTypes.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
          </select>
        </div>
        <div className="space-y-xs">
          <label className="text-xs font-semibold text-outline uppercase tracking-wider">Max Marks</label>
          <input type="number" value={maxMarks} onChange={(e) => setMaxMarks(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none w-24" />
        </div>
        {selectedCourse && students.length > 0 && (
          <Button onClick={saveMarks} disabled={loading}>{loading ? "Saving..." : "Save Marks"}</Button>
        )}
      </div>

      {/* Marks Entry */}
      {selectedCourse && (
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
