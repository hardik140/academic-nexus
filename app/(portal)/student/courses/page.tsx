import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { Database } from "@/types/database";

type EnrollmentStatus = Database["public"]["Tables"]["course_enrollments"]["Row"]["status"];

const FILTERS: { value: "all" | EnrollmentStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "enrolled", label: "Enrolled" },
  { value: "completed", label: "Completed" },
  { value: "dropped", label: "Dropped" },
];

export default async function StudentCourses({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student } = await supabase
    .from("students")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  const { status } = await searchParams;
  const activeFilter: "all" | EnrollmentStatus = FILTERS.find((f) => f.value === status)?.value ?? "all";

  let query = supabase
    .from("course_enrollments")
    // Enrollment names an OFFERING, so the instructor shown is the person
    // teaching this student's section — not whoever owns the catalog row.
    .select("*, course_offerings:offering_id(id, courses:course_id(id, name, code, credits, type, department_id, departments:department_id(name)), sections:section_id(name), semesters:semester_id(name), profiles:instructor_id(full_name))")
    // students(id): 047 repointed course_enrollments.student_id, and
    // comparing it to the profile id silently matched nothing.
    .eq("student_id", student?.id || "")
    .order("status");

  if (activeFilter !== "all") {
    query = query.eq("status", activeFilter);
  }

  const { data: enrollments } = await query;

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My Courses</h1>
        <p className="text-sm text-on-surface-variant mt-xs">All enrolled, completed, and dropped courses</p>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-xs border-b border-outline-variant">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "all" ? "/student/courses" : `/student/courses?status=${f.value}`}
            className={`px-md py-sm text-sm font-semibold capitalize motion-feedback border-b-2 -mb-[1px] ${
              activeFilter === f.value
                ? "text-secondary border-secondary"
                : "text-outline border-transparent hover:text-on-surface-variant"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {(enrollments || []).map((e: any) => {
          const offering = e.course_offerings;
          const course = offering?.courses;
          return (
            <div key={e.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
              <div className="flex items-center justify-between mb-sm">
                <span className="text-xs font-bold text-secondary uppercase tracking-wider">{course?.code}</span>
                <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                  e.status === "enrolled" ? "bg-success/10 text-success" :
                  e.status === "completed" ? "bg-info/10 text-info" :
                  e.status === "dropped" ? "bg-error/10 text-error" : "bg-warning/10 text-warning"
                }`}>{e.status}</span>
              </div>
              <h3 className="text-sm font-bold text-on-surface mb-xs">{course?.name}</h3>
              <div className="space-y-xs text-xs text-outline">
                <div>📚 {course?.credits} credits • {course?.type} • Sem {course?.semester}</div>
                <div>🏢 {(course?.departments as any)?.name || "—"}</div>
                <div>👨‍🏫 {(course?.profiles as any)?.full_name || "TBA"}</div>
              </div>
              {e.grade && (
                <div className="mt-md pt-sm border-t border-outline-variant flex items-center justify-between">
                  <span className="text-xs text-outline">Final Grade</span>
                  <span className="text-sm font-bold text-secondary">{e.grade}</span>
                </div>
              )}
            </div>
          );
        })}
        {(!enrollments || enrollments.length === 0) && (
          <div className="col-span-full bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            {activeFilter === "all" ? "No course enrollments found. Contact your department admin." : `No ${activeFilter} courses.`}
          </div>
        )}
      </div>
    </div>
  );
}
