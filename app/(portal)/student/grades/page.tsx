import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function StudentGrades() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student } = await supabase.from("students").select("id, cgpa").eq("user_id", user.id).single();

  const { data: marks } = await supabase
    .from("marks")
    .select("*, courses(name, code, credits)")
    .eq("student_id", student?.id || "")
    .order("semester", { ascending: false });

  // Group marks by course
  const courseMarks: Record<string, { course: any; exams: any[] }> = {};
  (marks || []).forEach((m: any) => {
    if (!courseMarks[m.course_id]) {
      courseMarks[m.course_id] = { course: m.courses, exams: [] };
    }
    courseMarks[m.course_id].exams.push(m);
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Grades & Marks</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Your exam scores and academic performance</p>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl px-xl py-md shadow-sm text-center">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">CGPA</div>
          <div className="text-3xl font-extrabold text-secondary">{student?.cgpa?.toFixed(2) || "0.00"}</div>
        </div>
      </div>

      {Object.values(courseMarks).length > 0 ? Object.values(courseMarks).map(({ course, exams }) => (
        <div key={course?.code} className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <div>
              <span className="text-sm font-bold text-on-surface">{course?.code}</span>
              <span className="text-xs text-outline ml-sm">{course?.name} • {course?.credits} credits</span>
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
                        <span className={`text-sm font-bold ${pct >= 60 ? "text-success" : pct >= 40 ? "text-warning" : "text-error"}`}>
                          {pct.toFixed(1)}%
                        </span>
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
