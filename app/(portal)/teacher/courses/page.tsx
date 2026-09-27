import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function TeacherCourses() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // One card per DELIVERY. A teacher holding two sections of one course
  // sees two cards with two rosters, which the catalog-keyed version could
  // not represent at all.
  const { data: offerings } = await supabase
    .from("course_offerings")
    .select(
      "id, status, courses:course_id(id, name, code, credits, type, departments:department_id(name, code)), sections:section_id(name, batch_year), semesters:semester_id(name)"
    )
    .eq("instructor_id", user.id);

  const offeringList = ((offerings as any[]) || []).sort((a, b) =>
    `${a.courses?.code}${a.sections?.name}`.localeCompare(`${b.courses?.code}${b.sections?.name}`)
  );

  const offeringIds = offeringList.map((o) => o.id);
  const { data: enrollments } = offeringIds.length > 0
    ? await supabase.from("course_enrollments").select("offering_id").in("offering_id", offeringIds).eq("status", "enrolled")
    : { data: [] };

  const enrollCounts: Record<string, number> = {};
  ((enrollments as any[]) || []).forEach((e) => {
    enrollCounts[e.offering_id] = (enrollCounts[e.offering_id] || 0) + 1;
  });

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My Classes</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Each card is one section of one course in one semester</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {offeringList.map((o: any) => (
          <div key={o.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm group">
            <div className="flex items-center justify-between mb-sm">
              <span className="text-xs font-bold text-secondary uppercase tracking-wider">{o.courses?.code}</span>
              <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                o.status === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
              }`}>{o.status}</span>
            </div>
            <h3 className="text-sm font-bold text-on-surface mb-xs group-hover:text-secondary transition-colors">{o.courses?.name}</h3>
            <div className="space-y-xs text-xs text-outline">
              <div>👥 {o.sections?.name ? `Section ${o.sections.name}` : "Section —"}{o.sections?.batch_year ? ` • Batch ${o.sections.batch_year}` : ""}</div>
              <div>🗓 {o.semesters?.name || "—"}</div>
              <div>🏢 {o.courses?.departments?.name || "—"}</div>
              <div>📚 {o.courses?.credits} credits • {o.courses?.type}</div>
            </div>
            <div className="flex items-center justify-between mt-md pt-sm border-t border-outline-variant">
              <span className="text-xs text-outline">👥 {enrollCounts[o.id] || 0} enrolled</span>
              <a href={`/teacher/attendance?offering=${o.id}`} className="text-xs font-semibold text-secondary hover:underline">
                View Roster →
              </a>
            </div>
          </div>
        ))}
        {offeringList.length === 0 && (
          <div className="col-span-full bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            No classes assigned. Contact admin for teaching assignments.
          </div>
        )}
      </div>
    </div>
  );
}
