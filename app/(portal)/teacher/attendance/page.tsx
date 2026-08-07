"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/modal";
import { saveAttendance } from "./actions";
import type { Database } from "@/types/database";

type AttendanceStatus = Database["public"]["Tables"]["attendance"]["Row"]["status"];

export default function TeacherAttendance() {
  const supabase = createClient();
  const [courses, setCourses] = useState<any[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>("");
  const [students, setStudents] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  useEffect(() => {
    loadCourses();
  }, []);

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
      .select("student_id, profiles:student_id(id, full_name, email)")
      .eq("course_id", courseId)
      .eq("status", "enrolled");

    const studentList = (enrollments || []).map((e: any) => ({
      id: e.student_id,
      full_name: (e.profiles as any)?.full_name || "Unknown",
      email: (e.profiles as any)?.email || "",
    }));

    setStudents(studentList);

    // Load existing attendance for this date
    const { data: existing } = await supabase
      .from("attendance")
      .select("student_id, status")
      .eq("course_id", courseId)
      .eq("date", date);

    const att: Record<string, string> = {};
    (existing || []).forEach((a: any) => { att[a.student_id] = a.status; });

    // Default all to "present"
    studentList.forEach((s: any) => {
      if (!att[s.id]) att[s.id] = "present";
    });
    setAttendance(att);
  };

  const toggleStatus = (studentId: string) => {
    const current = attendance[studentId] || "present";
    const cycle = ["present", "absent", "late", "excused"];
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    setAttendance({ ...attendance, [studentId]: next });
  };

  const handleSaveAttendance = async () => {
    setLoading(true);
    setError(null);
    try {
      // Get student records (need student.id, not user_id)
      const studentIds = Object.keys(attendance);
      const { data: studentRecords } = await supabase
        .from("students")
        .select("id, user_id")
        .in("user_id", studentIds);

      const entries = (studentRecords || []).map((s: any) => ({
        studentDbId: s.id,
        status: (attendance[s.user_id] || "present") as AttendanceStatus,
      }));

      await saveAttendance({ courseId: selectedCourse, date, entries });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save attendance.");
    } finally {
      setLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    present: "bg-success text-on-success",
    absent: "bg-error text-on-error",
    late: "bg-warning text-on-warning",
    excused: "bg-info text-white",
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Mark Attendance</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Select a course and mark student attendance</p>
      </div>

      {saved && (
        <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">
          ✅ Attendance saved successfully for {date}!
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Live Counts */}
      {selectedCourse && students.length > 0 && (
        <div className="grid grid-cols-3 gap-md">
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
            <div className="text-2xl font-extrabold text-success">{Object.values(attendance).filter(v => v === "present").length}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">Present</div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
            <div className="text-2xl font-extrabold text-error">{Object.values(attendance).filter(v => v === "absent").length}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">Absent</div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
            <div className="text-2xl font-extrabold text-warning">{Object.values(attendance).filter(v => v === "late").length}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">Late</div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-md items-end">
        <div className="space-y-xs">
          <label className="text-xs font-semibold text-outline uppercase tracking-wider">Course</label>
          <select
            value={selectedCourse}
            onChange={(e) => loadStudents(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none min-w-[200px]"
          >
            <option value="">Select course...</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-xs">
          <label className="text-xs font-semibold text-outline uppercase tracking-wider">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
          />
        </div>
        {selectedCourse && students.length > 0 && (
          <Button onClick={handleSaveAttendance} disabled={loading}>
            {loading ? "Saving..." : "Save Attendance"}
          </Button>
        )}
      </div>

      {/* Status Legend */}
      {selectedCourse && (
        <div className="flex gap-sm text-xs">
          <span className="text-outline">Click to toggle:</span>
          {["present", "absent", "late", "excused"].map((s) => (
            <span key={s} className={`px-sm py-xs rounded-full font-semibold capitalize ${statusColors[s]}`}>{s}</span>
          ))}
        </div>
      )}

      {/* Student List */}
      {selectedCourse && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">
              👥 Students ({students.length})
            </h2>
            <div className="flex gap-sm text-xs text-outline">
              <span className="text-success font-semibold">{Object.values(attendance).filter(v => v === "present").length}P</span>
              <span className="text-error font-semibold">{Object.values(attendance).filter(v => v === "absent").length}A</span>
              <span className="text-warning font-semibold">{Object.values(attendance).filter(v => v === "late").length}L</span>
            </div>
          </div>
          <div className="divide-y divide-outline-variant">
            {students.map((s: any, i: number) => (
              <div
                key={s.id}
                className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors cursor-pointer"
                onClick={() => toggleStatus(s.id)}
              >
                <div className="flex items-center gap-sm">
                  <span className="text-xs text-outline w-6 text-right">{i + 1}.</span>
                  <div className="w-8 h-8 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-xs font-bold">
                    {s.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-on-surface">{s.full_name}</div>
                    <div className="text-xs text-outline">{s.email}</div>
                  </div>
                </div>
                <button
                  className={`px-md py-xs rounded-full text-xs font-bold min-w-[80px] text-center capitalize transition-all ${statusColors[attendance[s.id] || "present"]}`}
                  onClick={(e) => { e.stopPropagation(); toggleStatus(s.id); }}
                >
                  {attendance[s.id] || "present"}
                </button>
              </div>
            ))}
            {students.length === 0 && (
              <div className="p-xl text-center text-sm text-outline">
                {selectedCourse ? "No students enrolled in this course." : "Select a course to view students."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
