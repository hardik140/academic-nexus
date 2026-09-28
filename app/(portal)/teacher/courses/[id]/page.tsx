import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/modal";
import { computeSubjectRisk } from "@/lib/academic-scoring";
import { formatPct } from "@/lib/utils";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";

// Embedded-select casts throughout this file: the hand-maintained Database
// type declares no Relationships, so supabase-js can't infer these shapes
// (same workaround as placements/actions.ts's DriveWithCompany).
type OfferingWithContext = {
  id: string;
  status: string;
  instructor_id: string | null;
  courses: { id: string; name: string; code: string; credits: number; departments: { name: string } | null } | null;
  sections: { name: string; batch_year: number } | null;
  semesters: { name: string } | null;
};
type EnrollmentWithStudent = {
  student_id: string;
  students: { id: string; enrollment_number: string | null; profiles: { full_name: string; email: string } | null } | null;
};

export default async function TeacherCoursePulse({ params }: { params: Promise<{ id: string }> }) {
  // The route parameter is an OFFERING id — this page is the pulse of one
  // class (course + section + semester), not of a catalog entry. A course
  // taught to three sections has three pulses, and averaging them into one
  // was the old page's central inaccuracy.
  const { id: offeringId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: offeringRaw, error: offeringRawError } = await supabase
    .from("course_offerings")
    .select(
      "id, status, instructor_id, courses:course_id(id, name, code, credits, departments:department_id(name)), sections:section_id(name, batch_year), semesters:semester_id(name)"
    )
    .eq("id", offeringId)
    .single();
  assertRead(offeringRawError);
  const offering = offeringRaw as unknown as OfferingWithContext | null;
  if (!offering) notFound();

  // Authority comes from the OFFERING's instructor assignment, never from
  // courses.instructor_id — which asked "who owns this course institution-
  // wide" and answered wrongly the moment two teachers split a course.
  if (offering.instructor_id !== user.id) {
    redirect("/teacher/courses");
  }

  const course = offering.courses;

  const [enrollmentsRes, attendanceRes, marksRes] = await Promise.all([
    supabase
      .from("course_enrollments")
      .select("student_id, students:student_id(id, enrollment_number, profiles:user_id(full_name, email))")
      .eq("offering_id", offeringId)
      .eq("status", "enrolled"),
    supabase.from("attendance").select("*").eq("offering_id", offeringId),
    supabase.from("marks").select("*").eq("offering_id", offeringId),
  ]);
  for (const res of [enrollmentsRes, attendanceRes, marksRes]) assertRead(res.error);

  const enrollments = (enrollmentsRes.data || []) as unknown as EnrollmentWithStudent[];
  // student_id is a students(id) on every one of these tables now (047), so
  // the profiles<->students bridge this page used to build is gone.
  const enrolledStudents = enrollments.map((e) => ({
    studentId: e.student_id,
    fullName: e.students?.profiles?.full_name || "Unknown",
    email: e.students?.profiles?.email || "",
    enrollmentNumber: e.students?.enrollment_number || "",
  }));
  const attendance = attendanceRes.data || [];
  const marks = marksRes.data || [];

  const totalAttendanceRows = attendance.length;
  const presentOrLate = attendance.filter((a) => a.status === "present" || a.status === "late").length;
  const attendancePct = totalAttendanceRows > 0 ? Math.round((presentOrLate / totalAttendanceRows) * 1000) / 10 : null;

  const totalMarksPct = marks.reduce((sum, m) => sum + (m.obtained_marks / m.max_marks) * 100, 0);
  const avgMarksPct = marks.length > 0 ? Math.round((totalMarksPct / marks.length) * 10) / 10 : null;

  const studentsWithRisk = enrolledStudents.map((s) => {
    const risk = computeSubjectRisk({
      offering: { id: offeringId },
      attendanceRows: attendance.filter((a) => a.student_id === s.studentId),
      marksRows: marks.filter((m) => m.student_id === s.studentId),
    });
    return { ...s, risk };
  });
  const needsAttention = studentsWithRisk.filter((s) => s.risk.level !== "low");

  return (
    <div className="space-y-lg">
      <div>
        <Link href="/teacher/courses" className="text-xs font-semibold text-secondary hover:underline">← My Classes</Link>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight mt-xs">{course?.code} — {course?.name}</h1>
        {/* The delivery context spelled out: which section, which term, which
            department. The course code alone does not identify this class. */}
        <p className="text-sm text-on-surface-variant mt-xs">
          {offering.sections?.name ? `Section ${offering.sections.name}` : "Section —"}
          {offering.semesters?.name ? ` • ${offering.semesters.name}` : ""}
          {` • ${course?.departments?.name || "—"}`}
          {` • ${course?.credits ?? "—"} credits`}
        </p>
      </div>

      <div className="flex gap-sm">
        <Link href={`/teacher/attendance?offering=${offeringId}`} className="text-xs font-semibold text-secondary hover:underline">Mark Attendance →</Link>
        <span className="text-outline">·</span>
        <Link href={`/teacher/grading?offering=${offeringId}`} className="text-xs font-semibold text-secondary hover:underline">Enter Marks →</Link>
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
              <div key={s.studentId} className="px-lg py-md">
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
            <div key={s.studentId} className="flex items-center justify-between px-lg py-md">
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
