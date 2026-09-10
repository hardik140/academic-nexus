import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { StudentDashboardClient } from "./dashboard-client";
import { computeAcademicHealth, buildSubjectRisks } from "@/lib/academic-scoring";
import { listOpportunities } from "@/app/(portal)/student/placements/actions";
import type { Database } from "@/types/database";

// See insights/page.tsx for why this cast is needed — same hand-maintained
// Database type / empty Relationships limitation.
type CourseEnrollmentRow = Database["public"]["Tables"]["course_enrollments"]["Row"];
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type AttendanceRow = Database["public"]["Tables"]["attendance"]["Row"];
type EnrollmentWithOffering = CourseEnrollmentRow & {
  course_offerings: {
    id: string;
    courses: CourseRow | null;
    sections: { name: string } | null;
    semesters: { name: string } | null;
  } | null;
};

export default async function StudentDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const { data: student } = await supabase
    .from("students")
    .select("*")
    .eq("user_id", user.id)
    .single();

  // Full attendance/marks/enrollment history for this student — needed (not
  // just a recent slice) so the Academic Health score and risk reasons are
  // computed from the same complete picture the director's rollup uses,
  // not an artificially recent window.
  const [attendanceRes, marksRes, enrollmentsRes, feesRes, notificationsRes] = await Promise.all([
    supabase
      .from("attendance")
      .select("*, course_offerings:offering_id(courses:course_id(name, code), sections:section_id(name))")
      .eq("student_id", student?.id || "")
      .order("date", { ascending: false }),
    supabase
      .from("marks")
      .select("*")
      .eq("student_id", student?.id || ""),
    supabase
      .from("course_enrollments")
      .select(
        "*, course_offerings:offering_id(id, courses:course_id(id, name, code, credits, type), sections:section_id(name), semesters:semester_id(name))"
      )
      // students(id), not the profile id — 047 repointed this column, and
      // comparing it to user.id silently matched nothing.
      .eq("student_id", student?.id || ""),
    supabase
      .from("fees")
      .select("*")
      .eq("student_id", student?.id || "")
      .in("status", ["pending", "overdue"])
      .order("due_date", { ascending: true }),
    supabase
      .from("notifications")
      .select("*")
      .eq("receiver_id", user.id)
      .eq("read", false)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const attendance = (attendanceRes.data || []) as AttendanceRow[];
  const marks = marksRes.data || [];
  const enrollments = (enrollmentsRes.data || []) as unknown as EnrollmentWithOffering[];
  const fees = feesRes.data || [];
  const notifications = notificationsRes.data || [];

  const academicHealth = computeAcademicHealth({
    attendance,
    enrollments,
    cgpa: student?.cgpa ?? null,
  });

  // Same helper the Insights page's full Risk Radar uses — the dashboard
  // just surfaces the non-"low" subset in Attention Required.
  const subjectRisks = buildSubjectRisks({ enrollments, attendance, marks });

  // Eligible placement drives this student hasn't applied to yet, reusing
  // the placements module's own eligibility logic rather than re-deriving
  // min_cgpa/batch/department filtering here.
  let upcomingPlacementDeadlines: Awaited<ReturnType<typeof listOpportunities>> = [];
  try {
    const opportunities = await listOpportunities();
    upcomingPlacementDeadlines = opportunities.filter((o) => !o.applicationStatus);
  } catch {
    // Student profile not resolvable, or no drives at all — action center
    // simply omits placement items rather than surfacing a fetch error.
  }

  return (
    <StudentDashboardClient
      profile={profile}
      student={student}
      attendance={attendance}
      fees={fees}
      notifications={notifications}
      academicHealth={academicHealth}
      subjectRisks={subjectRisks}
      upcomingPlacementDeadlines={upcomingPlacementDeadlines}
    />
  );
}
