import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { StudentInsightsClient } from "./insights-client";
import { buildSubjectRisks, computeDegreeProgress } from "@/lib/academic-scoring";
import type { Database } from "@/types/database";

// The hand-maintained Database type's Relationships arrays are empty (see
// types/database.ts's own header comment and placements/actions.ts's
// identical workaround), so supabase-js can't infer this embedded-select
// shape — cast explicitly instead of letting it collapse to `never`.
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type CourseEnrollmentRow = Database["public"]["Tables"]["course_enrollments"]["Row"];
type AttendanceRow = Database["public"]["Tables"]["attendance"]["Row"];
type EnrollmentWithCourse = CourseEnrollmentRow & { courses: CourseRow | null };

export default async function StudentInsights() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: student } = await supabase
    .from("students")
    .select("*")
    .eq("user_id", user.id)
    .single();

  const [attendanceRes, marksRes, enrollmentsRes] = await Promise.all([
    supabase
      .from("attendance")
      .select("*, courses(name, code)")
      .eq("student_id", student?.id || ""),
    supabase
      .from("marks")
      .select("*")
      .eq("student_id", student?.id || ""),
    supabase
      .from("course_enrollments")
      .select("*, courses(id, name, code, credits, type)")
      .eq("student_id", user.id),
  ]);

  const attendance = (attendanceRes.data || []) as AttendanceRow[];
  const marks = marksRes.data || [];
  const enrollments = (enrollmentsRes.data || []) as EnrollmentWithCourse[];

  const subjectRisks = buildSubjectRisks({ enrollments, attendance, marks });

  const coursesById = new Map<string, CourseRow>();
  for (const e of enrollments) {
    if (e.courses) coursesById.set(e.courses.id, e.courses);
  }
  const degreeProgress = computeDegreeProgress({
    enrollments,
    coursesById,
    creditsCompleted: student?.credits_completed || 0,
    creditsRequired: student?.credits_required || 160,
  });

  // Per-course present/total for the Attendance Forecast tab's course
  // selector, plus an "All courses" aggregate as the default.
  const attendanceByCourse = Array.from(coursesById.values())
    .map((course) => {
      const rows = attendance.filter((a) => a.course_id === course.id);
      const present = rows.filter((a) => a.status === "present" || a.status === "late").length;
      return { courseId: course.id, courseName: course.name, present, total: rows.length };
    })
    .filter((c) => c.total > 0);
  const overallAttendance = {
    present: attendance.filter((a) => a.status === "present" || a.status === "late").length,
    total: attendance.length,
  };

  return (
    <StudentInsightsClient
      subjectRisks={subjectRisks}
      degreeProgress={degreeProgress}
      attendanceByCourse={attendanceByCourse}
      overallAttendance={overallAttendance}
    />
  );
}
