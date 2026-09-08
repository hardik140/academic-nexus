import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { TeacherDashboardClient, type PriorityAction } from "./dashboard-client";
import type { Database } from "@/types/database";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Embedded-select cast: the hand-maintained Database type declares no
// Relationships, so supabase-js can't infer this shape (same workaround as
// placements/actions.ts's DriveWithCompany).
type TimetableSlotRow = Database["public"]["Tables"]["timetable_slots"]["Row"];
type SlotWithCourse = TimetableSlotRow & { courses: { name: string; code: string } | null };

export default async function TeacherDashboard() {
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

  const { data: coursesData } = await supabase
    .from("courses")
    .select("*")
    .eq("instructor_id", user.id);
  const courses = coursesData || [];
  const courseIds = courses.map((c) => c.id);

  const todayIndex = new Date().getDay();
  const today = new Date().toISOString().split("T")[0];

  const [enrollmentsRes, attendanceRes, marksRes, todaySlotsRes, leaveRes, correctionsRes, notificationsRes] =
    await Promise.all([
      courseIds.length
        ? supabase.from("course_enrollments").select("student_id, course_id").in("course_id", courseIds).eq("status", "enrolled")
        : Promise.resolve({ data: [] }),
      courseIds.length
        ? supabase.from("attendance").select("course_id, date, status").in("course_id", courseIds)
        : Promise.resolve({ data: [] }),
      courseIds.length
        ? supabase.from("marks").select("course_id, student_id, exam_type").in("course_id", courseIds)
        : Promise.resolve({ data: [] }),
      supabase
        .from("timetable_slots")
        .select("*, courses(name, code)")
        .eq("instructor_id", user.id)
        .eq("day_of_week", todayIndex)
        .order("start_time"),
      supabase.from("leave_requests").select("id").eq("requested_by", user.id).eq("status", "pending"),
      supabase.from("attendance_correction_requests").select("id").eq("submitted_by", user.id).eq("status", "pending"),
      supabase
        .from("notifications")
        .select("*")
        .eq("receiver_id", user.id)
        .eq("read", false)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  const enrollments = enrollmentsRes.data || [];
  const attendance = attendanceRes.data || [];
  const marks = marksRes.data || [];
  const todaySlots = (todaySlotsRes.data || []) as unknown as SlotWithCourse[];
  const pendingLeaveCount = leaveRes.data?.length || 0;
  const pendingCorrectionCount = correctionsRes.data?.length || 0;
  const notifications = notificationsRes.data || [];

  // course_enrollments.student_id references profiles(id), marks.student_id
  // references students(id) — bridge the two id spaces once here (same
  // quirk documented in migration 002/032, and the same fix already applied
  // to teacher/attendance/page.tsx's own student-list loading).
  const enrolledProfileIds = Array.from(new Set(enrollments.map((e) => e.student_id)));
  const { data: studentRows } = enrolledProfileIds.length
    ? await supabase.from("students").select("id, user_id").in("user_id", enrolledProfileIds)
    : { data: [] };
  const profileIdToStudentDbId = new Map((studentRows || []).map((s) => [s.user_id, s.id]));

  const totalStudents = enrolledProfileIds.length;
  const totalAttendanceRows = attendance.length;
  const presentOrLate = attendance.filter((a) => a.status === "present" || a.status === "late").length;
  const avgAttendancePct = totalAttendanceRows > 0 ? Math.round((presentOrLate / totalAttendanceRows) * 1000) / 10 : null;

  const actions: PriorityAction[] = [];

  // Today's classes with no attendance submitted yet for today.
  const attendanceTodayCourseIds = new Set(attendance.filter((a) => a.date === today).map((a) => a.course_id));
  for (const slot of todaySlots) {
    if (!attendanceTodayCourseIds.has(slot.course_id)) {
      const course = slot.courses;
      actions.push({
        source: "Attendance",
        title: `Attendance not submitted — ${course?.code || "class"} at ${slot.start_time?.slice(0, 5)}`,
        priority: "high",
        href: `/teacher/attendance?course=${slot.course_id}`,
      });
    }
  }

  // Marks entry started-but-incomplete per course/exam type — only flags
  // exam types the teacher has actually begun entering, never one never
  // started, so this can't be misread as "grade everything right now."
  const enrolledStudentDbIdsByCourse = new Map<string, Set<string>>();
  for (const e of enrollments) {
    const studentDbId = profileIdToStudentDbId.get(e.student_id);
    if (!studentDbId) continue;
    if (!enrolledStudentDbIdsByCourse.has(e.course_id)) enrolledStudentDbIdsByCourse.set(e.course_id, new Set());
    enrolledStudentDbIdsByCourse.get(e.course_id)!.add(studentDbId);
  }
  const markedByCoursExam = new Map<string, Set<string>>();
  for (const m of marks) {
    const key = `${m.course_id}::${m.exam_type}`;
    if (!markedByCoursExam.has(key)) markedByCoursExam.set(key, new Set());
    markedByCoursExam.get(key)!.add(m.student_id);
  }
  for (const [key, markedStudentIds] of markedByCoursExam) {
    const [courseId, examType] = key.split("::");
    const enrolledSet = enrolledStudentDbIdsByCourse.get(courseId);
    if (!enrolledSet) continue;
    const missing = enrolledSet.size - [...enrolledSet].filter((id) => markedStudentIds.has(id)).length;
    if (missing > 0) {
      const course = courses.find((c) => c.id === courseId);
      actions.push({
        source: "Marks",
        title: `${missing} of ${enrolledSet.size} students missing ${examType.replace(/_/g, " ")} marks in ${course?.code || "a course"}`,
        priority: "medium",
        href: `/teacher/grading?course=${courseId}`,
      });
    }
  }

  if (pendingLeaveCount > 0) {
    actions.push({
      source: "Leave",
      title: `${pendingLeaveCount} leave request${pendingLeaveCount !== 1 ? "s" : ""} awaiting HOD action`,
      priority: "low",
      href: "/teacher/leave",
    });
  }
  if (pendingCorrectionCount > 0) {
    actions.push({
      source: "Attendance",
      title: `${pendingCorrectionCount} correction request${pendingCorrectionCount !== 1 ? "s" : ""} awaiting HOD action`,
      priority: "low",
      href: "/teacher/attendance",
    });
  }

  const priorityOrder = { high: 0, medium: 1, low: 2 } as const;
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return (
    <TeacherDashboardClient
      profile={profile}
      courses={courses}
      todaySlots={todaySlots}
      totalStudents={totalStudents}
      avgAttendancePct={avgAttendancePct}
      actions={actions}
      notifications={notifications}
      todayLabel={DAY_NAMES[todayIndex]}
    />
  );
}
