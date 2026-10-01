import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { TeacherDashboardClient, type PriorityAction } from "./dashboard-client";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";
import { todayDayOfWeek, todayInTimeZone } from "@/lib/format";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Embedded-select cast: the hand-maintained Database type declares no
// Relationships, so supabase-js can't infer this shape (same workaround as
// placements/actions.ts's DriveWithCompany).
type TimetableSlotRow = Database["public"]["Tables"]["timetable_slots"]["Row"];
type SlotWithCourse = TimetableSlotRow & {
  course_offerings: {
    id: string;
    courses: { name: string; code: string } | null;
    sections: { name: string } | null;
  } | null;
};

type OfferingSummary = {
  id: string;
  status: string;
  courses: { id: string; name: string; code: string } | null;
  sections: { name: string } | null;
};

export default async function TeacherDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  assertRead(profileError);

  // The teacher's DELIVERIES this term, not the catalog rows they own. Two
  // sections of one course are two entries here, each with its own roll,
  // register and marks sheet — which is the whole point of the offering
  // model and was inexpressible before it.
  const { data: offeringsData, error: offeringsDataError } = await supabase
    .from("course_offerings")
    .select("id, status, courses:course_id(id, name, code), sections:section_id(name)")
    .eq("instructor_id", user.id);
  assertRead(offeringsDataError);
  const offerings = ((offeringsData as unknown as OfferingSummary[]) || []).filter(
    (o) => o.status !== "cancelled"
  );
  const offeringIds = offerings.map((o) => o.id);

  const todayIndex = todayDayOfWeek();
  const today = todayInTimeZone();

  const [enrollmentsRes, attendanceRes, marksRes, todaySlotsRes, leaveRes, correctionsRes, notificationsRes] =
    await Promise.all([
      offeringIds.length
        ? supabase.from("course_enrollments").select("student_id, offering_id").in("offering_id", offeringIds).eq("status", "enrolled")
        : Promise.resolve({ data: [] }),
      offeringIds.length
        ? supabase.from("attendance").select("offering_id, date, status").in("offering_id", offeringIds)
        : Promise.resolve({ data: [] }),
      offeringIds.length
        ? supabase.from("marks").select("offering_id, student_id, exam_type").in("offering_id", offeringIds)
        : Promise.resolve({ data: [] }),
      offeringIds.length
        ? supabase
            .from("timetable_slots")
            .select("*, course_offerings:offering_id(id, courses:course_id(name, code), sections:section_id(name))")
            .in("offering_id", offeringIds)
            .eq("day_of_week", todayIndex)
            .order("start_time")
        : Promise.resolve({ data: [] }),
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
  for (const res of [enrollmentsRes, attendanceRes, marksRes, todaySlotsRes, leaveRes, correctionsRes, notificationsRes]) assertRead("error" in res ? res.error : null);

  const enrollments = enrollmentsRes.data || [];
  const attendance = attendanceRes.data || [];
  const marks = marksRes.data || [];
  const todaySlots = (todaySlotsRes.data || []) as unknown as SlotWithCourse[];
  const pendingLeaveCount = leaveRes.data?.length || 0;
  const pendingCorrectionCount = correctionsRes.data?.length || 0;
  const notifications = notificationsRes.data || [];

  // No id-space bridge any more: course_enrollments.student_id and
  // marks.student_id both reference students(id) after 047, so these
  // compare directly. The extra round trip this page used to make, and the
  // class of silent wrong-join bug it existed to work around, are both gone.
  const enrolledStudentIds = Array.from(new Set(enrollments.map((e) => e.student_id)));

  const totalStudents = enrolledStudentIds.length;
  const totalAttendanceRows = attendance.length;
  const presentOrLate = attendance.filter((a) => a.status === "present" || a.status === "late").length;
  const avgAttendancePct = totalAttendanceRows > 0 ? Math.round((presentOrLate / totalAttendanceRows) * 1000) / 10 : null;

  const actions: PriorityAction[] = [];

  // Today's classes with no attendance submitted yet for today.
  const attendanceTodayOfferingIds = new Set(
    attendance.filter((a) => a.date === today).map((a) => a.offering_id)
  );
  for (const slot of todaySlots) {
    if (!slot.course_offerings || attendanceTodayOfferingIds.has(slot.course_offerings.id)) continue;
    const course = slot.course_offerings.courses;
    const section = slot.course_offerings.sections?.name;
    actions.push({
      source: "Attendance",
      title: `Attendance not submitted — ${course?.code || "class"}${section ? ` (${section})` : ""} at ${slot.start_time?.slice(0, 5)}`,
      priority: "high",
      href: `/teacher/attendance?offering=${slot.course_offerings.id}`,
    });
  }

  // Marks entry started-but-incomplete per course/exam type — only flags
  // exam types the teacher has actually begun entering, never one never
  // started, so this can't be misread as "grade everything right now."
  const enrolledByOffering = new Map<string, Set<string>>();
  for (const e of enrollments) {
    if (!enrolledByOffering.has(e.offering_id)) enrolledByOffering.set(e.offering_id, new Set());
    enrolledByOffering.get(e.offering_id)!.add(e.student_id);
  }
  const markedByOfferingExam = new Map<string, Set<string>>();
  for (const m of marks) {
    const key = `${m.offering_id}::${m.exam_type}`;
    if (!markedByOfferingExam.has(key)) markedByOfferingExam.set(key, new Set());
    markedByOfferingExam.get(key)!.add(m.student_id);
  }
  for (const [key, markedStudentIds] of markedByOfferingExam) {
    const [offeringId, examType] = key.split("::");
    const enrolledSet = enrolledByOffering.get(offeringId);
    if (!enrolledSet) continue;
    const missing = enrolledSet.size - [...enrolledSet].filter((id) => markedStudentIds.has(id)).length;
    if (missing > 0) {
      const offering = offerings.find((o) => o.id === offeringId);
      const label = offering?.sections?.name
        ? `${offering.courses?.code || "a course"} (${offering.sections.name})`
        : offering?.courses?.code || "a course";
      actions.push({
        source: "Marks",
        title: `${missing} of ${enrolledSet.size} students missing ${examType.replace(/_/g, " ")} marks in ${label}`,
        priority: "medium",
        href: `/teacher/grading?offering=${offeringId}`,
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
      courses={offerings}
      todaySlots={todaySlots}
      totalStudents={totalStudents}
      avgAttendancePct={avgAttendancePct}
      actions={actions}
      notifications={notifications}
      todayLabel={DAY_NAMES[todayIndex]}
    />
  );
}
