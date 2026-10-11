import type { AcademicContext } from "@/lib/academic/types";

/**
 * A student's current academic placement, from my_academic_context() (055 —
 * the same read the mobile app uses): the college term, their programme,
 * class (year of study), programme semester, section and Class In-Charge.
 *
 * Presentational. A student who has not been placed in a section yet is
 * told so plainly instead of being shown a guessed one.
 */
export function AcademicContextCard({ context }: { context: AcademicContext }) {
  const s = context.section;
  const rows: [string, string][] = [
    ["Term", context.term ? `${context.term.name}${context.term.academic_year ? ` · ${context.term.academic_year}` : ""}` : "No active term"],
  ];
  if (context.student) rows.push(["Department", context.student.department.name]);
  if (s) {
    rows.push(["Programme", s.programme.name]);
    rows.push(["Class", s.year_of_study ? `Year ${s.year_of_study}` : "—"]);
  }
  if (context.student) rows.push(["Semester", String(context.student.programme_semester)]);
  if (s) {
    rows.push(["Section", `${s.name} (${s.batch_year} intake)`]);
    rows.push(["Class In-Charge", s.class_incharge?.full_name ?? "Not assigned yet"]);
  }

  return (
    <section
      aria-labelledby="academic-context-heading"
      className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
      data-testid="academic-context"
    >
      <h2 id="academic-context-heading" className="text-sm font-bold text-on-surface">Your class</h2>
      {context.student && !s && (
        <p className="mt-xs text-sm text-on-surface-variant">
          You have not been placed in a section yet. Your department will assign one; your timetable fills in when it does.
        </p>
      )}
      <dl className="mt-md grid grid-cols-1 gap-x-lg gap-y-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-on-surface-variant">{k}</dt>
            <dd className="text-sm font-semibold text-on-surface break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
