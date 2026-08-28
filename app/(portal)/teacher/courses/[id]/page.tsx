import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/modal";
import { computeSubjectRisk } from "@/lib/academic-scoring";
import { formatPct } from "@/lib/utils";
import type { Database } from "@/types/database";

// Embedded-select casts throughout this file: the hand-maintained Database
// type declares no Relationships, so supabase-js can't infer these shapes
// (same workaround as placements/actions.ts's DriveWithCompany).
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type CourseWithDepartment = CourseRow & { departments: { name: string } | null };
type EnrollmentWithProfile = { student_id: string; profiles: { id: string; full_name: string; email: string } | null };

export default async function TeacherCoursePulse({ params }: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: courseRaw } = await supabase.from("courses").select("*, departments:department_id(name)").eq("id", courseId).single();
  const course = courseRaw as CourseWithDepartment | null;
  if (!course) notFound();
  // A teacher may only view Class Pulse for a course they teach — same
  // ownership rule enforced server-side for marking attendance/grading.
  if (course.instructor_id !== user.id) {
    redirect("/teacher/courses");
  }

  const [enrollmentsRes, attendanceRes, marksRes] = await Promise.all([
    supabase
      .from("course_enrollments")
      .select("student_id, profiles:student_id(id, full_name, email)")
      .eq("course_id", courseId)
      .eq("status", "enrolled"),
    supabase.from("attendance").select("*").eq("course_id", courseId),
    supabase.from("marks").select("*").eq("course_id", courseId),
  ]);

  const enrollments = (enrollmentsRes.data || []) as unknown as EnrollmentWithProfile[];
  const enrolledStudents = enrollments.map((e) => ({
    profileId: e.student_id,
    fullName: e.profiles?.full_name || "Unknown",
    email: e.profiles?.email || "",
  }));
  const attendance = attendanceRes.data || [];
  const marks = marksRes.data || [];

  // attendance/marks.student_id reference students(id); enrollments'
  // student_id references profiles(id) — same bridge used on the dashboard.
  const profileIds = enrolledStudents.map((s) => s.profileId);
  const { data: studentRows } = profileIds.length
    ? await supabase.from("students").select("id, user_id").in("user_id", profileIds)
    : { data: [] };
  const profileIdToStudentDbId = new Map((studentRows || []).map((s) => [s.user_id, s.id]));

  const totalAttendanceRows = attendance.length;
  const presentOrLate = attendance.filter((a) => a.status === "present" || a.status === "late").length;
  const attendancePct = totalAttendanceRows > 0 ? Math.round((presentOrLate / totalAttendanceRows) * 1000) / 10 : null;

  const totalMarksPct = marks.reduce((sum, m) => sum + (m.obtained_marks / m.max_marks) * 100, 0);
  const avgMarksPct = marks.length > 0 ? Math.round((totalMarksPct / marks.length) * 10) / 10 : null;

  const studentsWithRisk = enrolledStudents.map((s) => {
    const studentDbId = profileIdToStudentDbId.get(s.profileId);
    const risk = computeSubjectRisk({
      course: { id: courseId },
      attendanceRows: studentDbId ? attendance.filter((a) => a.student_id === studentDbId) : [],
      marksRows: studentDbId ? marks.filter((m) => m.student_id === studentDbId) : [],
    });
    return { ...s, risk };
  });
  const needsAttention = studentsWithRisk.filter((s) => s.risk.level !== "low");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <Link href="/teacher/courses" className="text-xs font-semibold text-secondary hover:underline">← My Courses</Link>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight mt-xs">{course.code} — {course.name}</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          {course.departments?.name || "—"} • {course.credits} credits • Semester {course.semester}
        </p>
      </div>

      <div className="flex gap-sm">
        <Link href={`/teacher/attendance?course=${courseId}`} className="text-xs font-semibold text-secondary hover:underline">Mark Attendance →</Link>
        <span className="text-outline">·</span>
        <Link href={`/teacher/grading?course=${courseId}`} className="text-xs font-semibold text-secondary hover:underline">Enter Marks →</Link>
      </div>

      {/* Class Pulse stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Enrolled</div>
          <div className="text-3xl font-extrabold text-on-surface">{enrolledStudents.length}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Attendance</div>
          <div className={`text-3xl font-extrabold ${attendancePct != null && attendancePct < 75 ? "text-error" : "text-success"}`}>
            {attendancePct != null ? formatPct(attendancePct, 1) : "—"}
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Avg Marks</div>
          <div className="text-3xl font-extrabold text-on-surface">
            {avgMarksPct != null ? formatPct(avgMarksPct, 1) : "—"}
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Needs Attention</div>
          <div className={`text-3xl font-extrabold ${needsAttention.length > 0 ? "text-warning" : "text-success"}`}>
            {needsAttention.length}
          </div>
        </div>
      </div>

      {/* Students requiring attention */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Students Requiring Attention</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {needsAttention.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">No risk signals for this class right now.</div>
          ) : (
            needsAttention.map((s) => (
              <div key={s.profileId} className="px-lg py-md">
                <div className="flex items-center gap-sm mb-xs">
                  <StatusBadge status={s.risk.level} />
                  <span className="text-sm font-semibold text-on-surface">{s.fullName}</span>
                  <span className="text-xs text-outline">{s.email}</span>
                </div>
                {s.risk.reasons.map((reason, i) => (
                  <div key={i} className="text-xs text-on-surface-variant mt-xs">{reason}</div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Full roster */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Roster ({enrolledStudents.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {studentsWithRisk.map((s) => (
            <div key={s.profileId} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm font-medium text-on-surface">{s.fullName}</div>
                <div className="text-xs text-outline">{s.email}</div>
              </div>
              <StatusBadge status={s.risk.level} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
