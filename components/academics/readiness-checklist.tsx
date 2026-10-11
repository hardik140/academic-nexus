import type { DepartmentReadiness } from "@/lib/academic/types";

/**
 * What stands between a department and starting its term (055's
 * department_term_readiness). Blocking items stop a start; pending items —
 * offerings with no teacher yet — must be explicitly acknowledged.
 *
 * Presentational: severity is said in words as well as colour.
 */
export function ReadinessChecklist({ readiness }: { readiness: DepartmentReadiness }) {
  if (readiness.items.length === 0) {
    return (
      <p className="text-sm text-on-surface-variant" data-testid="readiness-clear">
        Everything the department needs for this term is in place.
      </p>
    );
  }
  const blocking = readiness.items.filter((i) => i.severity === "blocking");
  const pending = readiness.items.filter((i) => i.severity === "pending");
  return (
    <div className="space-y-md" data-testid="readiness-checklist">
      {blocking.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-error">Must be fixed before the term can start ({blocking.length})</h3>
          <ul className="mt-xs space-y-xs">
            {blocking.map((item, i) => (
              <li key={`${item.code}-${item.ref_id ?? i}`} className="flex gap-sm text-sm text-on-surface">
                <span aria-hidden="true" className="text-error">●</span>
                <span><span className="sr-only">Blocking: </span>{item.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pending.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">Can start without, if you confirm ({pending.length})</h3>
          <ul className="mt-xs space-y-xs">
            {pending.map((item, i) => (
              <li key={`${item.code}-${item.ref_id ?? i}`} className="flex gap-sm text-sm text-on-surface">
                <span aria-hidden="true" className="text-outline">○</span>
                <span><span className="sr-only">Pending: </span>{item.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
