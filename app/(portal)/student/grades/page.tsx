import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { assertRead } from "@/lib/read-result-server";
import { NO_MATCH_ID } from "@/lib/read-result";

export default async function StudentGrades() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student, error: studentError } = await supabase.from("students").select("id, cgpa").eq("user_id", user.id).single();
  assertRead(studentError);

  const { data: marks, error: marksError } = await supabase
    .from("marks")
    // marks.semester and marks.course_id were both dropped by 047 — the
    // academic period and the course now come from the offering.
    .select(
      "*, course_offerings:offering_id(courses:course_id(name, code, credits), sections:section_id(name), semesters:semester_id(name, start_date))"
    )
    .eq("student_id", student?.id || NO_MATCH_ID)
    .order("created_at", { ascending: false });
  assertRead(marksError);

  // Keyed by OFFERING so a retake is its own result block rather than
  // overwriting the earlier attempt.
  const courseMarks: Record<string, { course: any; section?: string; semester?: string; exams: any[] }> = {};
  (marks || []).forEach((m: any) => {
    if (!courseMarks[m.offering_id]) {
      courseMarks[m.offering_id] = {
        course: m.course_offerings?.courses,
        section: m.course_offerings?.sections?.name,
        semester: m.course_offerings?.semesters?.name,
        exams: [],
      };
    }
    courseMarks[m.offering_id].exams.push(m);
  });

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between flex-wrap gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Grades & Marks</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Your exam scores and academic performance</p>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl px-xl py-md shadow-sm text-center">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Current CGPA</div>
          <div className="text-3xl font-extrabold text-secondary">{student?.cgpa?.toFixed(2) || "0.00"}</div>
          <div className="h-1.5 w-24 bg-surface-container-high rounded-full overflow-hidden mt-xs">
            <div className="h-full bg-secondary rounded-full" style={{ width: `${((student?.cgpa || 0) / 10) * 100}%` }} />
          </div>
          <div className="text-[10px] text-outline mt-xs">out of 10.00</div>
        </div>
      </div>

      {Object.values(courseMarks).length > 0 ? Object.values(courseMarks).map(({ course, exams }) => (
        <div key={course?.code} className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <div className="flex items-center gap-sm">
              <span className="text-lg">📖</span>
              <div>
                <span className="text-sm font-bold text-on-surface">{course?.code}</span>
                <span className="text-xs text-outline ml-sm">{course?.name} • {course?.credits} credits</span>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-container-low text-on-surface-variant">
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Exam</th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Obtained</th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Max</th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Percentage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {exams.map((exam: any) => {
                  const pct = (exam.obtained_marks / exam.max_marks) * 100;
                  return (
                    <tr key={exam.id} className="hover:bg-surface-container-low transition-colors">
                      <td className="px-lg py-md font-medium text-on-surface capitalize">{exam.exam_type.replace(/_/g, " ")}</td>
                      <td className="px-lg py-md text-on-surface">{exam.obtained_marks}</td>
                      <td className="px-lg py-md text-on-surface-variant">{exam.max_marks}</td>
                      <td className="px-lg py-md">
                        <div className="flex items-center gap-sm">
                          <div className="w-16 h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${pct >= 60 ? "bg-success" : pct >= 40 ? "bg-warning" : "bg-error"}`}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className={`text-sm font-bold ${pct >= 60 ? "text-success" : pct >= 40 ? "text-warning" : "text-error"}`}>
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )) : (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
          No exam results available yet. Marks will appear here as they are published.
        </div>
      )}
    </div>
  );
}
