import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { StudentInsightsClient } from "./insights-client";
import { buildSubjectRisks, computeDegreeProgress } from "@/lib/academic-scoring";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";
import { NO_MATCH_ID } from "@/lib/read-result";

// The hand-maintained Database type's Relationships arrays are empty (see
// types/database.ts's own header comment and placements/actions.ts's
// identical workaround), so supabase-js can't infer this embedded-select
// shape — cast explicitly instead of letting it collapse to `never`.
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type CourseEnrollmentRow = Database["public"]["Tables"]["course_enrollments"]["Row"];
type AttendanceRow = Database["public"]["Tables"]["attendance"]["Row"];
type EnrollmentWithOffering = CourseEnrollmentRow & {
  course_offerings: {
    id: string;
    courses: CourseRow | null;
    sections: { name: string } | null;
    semesters: { name: string } | null;
  } | null;
};

export default async function StudentInsights() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("*")
    .eq("user_id", user.id)
    .single();
  assertRead(studentError);

  const [attendanceRes, marksRes, enrollmentsRes] = await Promise.all([
    supabase
      .from("attendance")
      .select("*")
      .eq("student_id", student?.id || NO_MATCH_ID),
    supabase
      .from("marks")
      .select("*")
      .eq("student_id", student?.id || NO_MATCH_ID),
    supabase
      .from("course_enrollments")
      .select(
        "*, course_offerings:offering_id(id, courses:course_id(id, name, code, credits, type), sections:section_id(name), semesters:semester_id(name))"
      )
      // students(id), not the profile id. course_enrollments.student_id was
      // repointed by 047; comparing it to user.id used to match nothing and
      // returned an empty insights page rather than an error.
      .eq("student_id", student?.id || NO_MATCH_ID),
  ]);
  for (const res of [attendanceRes, marksRes, enrollmentsRes]) assertRead(res.error);

  const attendance = (attendanceRes.data || []) as AttendanceRow[];
  const marks = marksRes.data || [];
  const enrollments = (enrollmentsRes.data || []) as unknown as EnrollmentWithOffering[];

  const subjectRisks = buildSubjectRisks({ enrollments, attendance, marks });

  // Keyed by OFFERING: a retake is a second enrollment on a second offering
  // of the same course, and each attempt carries its own credits outcome.
  const coursesByOfferingId = new Map<string, CourseRow>();
  for (const e of enrollments) {
    const course = e.course_offerings?.courses;
    if (course) coursesByOfferingId.set(e.offering_id, course);
  }
  const degreeProgress = computeDegreeProgress({
    enrollments,
    coursesByOfferingId,
    creditsCompleted: student?.credits_completed || 0,
    creditsRequired: student?.credits_required || 160,
  });

  // Per-CLASS present/total for the Attendance Forecast selector. Labelled
  // with the section so two sections of one course stay distinguishable.
  const attendanceByCourse = enrollments
    .map((e) => {
      const course = e.course_offerings?.courses;
      if (!course) return null;
      const rows = attendance.filter((a) => a.offering_id === e.offering_id);
      const section = e.course_offerings?.sections?.name;
      const present = rows.filter((a) => a.status === "present" || a.status === "late").length;
      return {
        courseId: e.offering_id,
        courseName: section ? `${course.name} (${section})` : course.name,
        present,
        total: rows.length,
      };
    })
    .filter((c): c is { courseId: string; courseName: string; present: number; total: number } =>
      c !== null && c.total > 0
    );
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
