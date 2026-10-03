import { Button } from "@/components/ui/modal";
import { DAY_NAMES } from "@/lib/academic/timetable";
import type { TimetableSlotRow } from "@/lib/academic/types";

/**
 * A department's week for the active term (055 §13), grouped by day. Each
 * class says its course, section, teacher, time and room in text.
 * Presentational: removing a class is the caller's action.
 */
const hhmm = (t: string) => t.slice(0, 5);

export function TimetableWeek({
  slots,
  onRemove,
  pendingSlotId,
}: {
  slots: TimetableSlotRow[];
  onRemove?: (slotId: string) => void;
  pendingSlotId?: string | null;
}) {
  if (slots.length === 0) {
    return <p className="text-sm text-on-surface-variant">No classes are scheduled yet for this term.</p>;
  }
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => slots.some((s) => s.day_of_week === d));
  return (
    <div className="space-y-md" data-testid="timetable-week">
      {days.map((day) => (
        <section key={day} aria-labelledby={`tt-day-${day}`}>
          <h3 id={`tt-day-${day}`} className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">{DAY_NAMES[day]}</h3>
          <ul className="mt-xs divide-y divide-outline-variant rounded-xl border border-outline-variant">
            {slots.filter((s) => s.day_of_week === day).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-sm px-md py-sm">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-on-surface">{hhmm(s.start_time)}–{hhmm(s.end_time)} · {s.label}</p>
                  <p className="text-xs text-on-surface-variant">{s.teacher ?? "No teacher"}{s.room ? ` · Room ${s.room}` : ""}</p>
                </div>
                {onRemove && (
                  <Button size="sm" variant="outline" disabled={pendingSlotId === s.id} aria-busy={pendingSlotId === s.id || undefined} onClick={() => onRemove(s.id)}>
                    {pendingSlotId === s.id ? "Removing…" : <>Remove<span className="sr-only"> {s.label} on {DAY_NAMES[day]} at {hhmm(s.start_time)}</span></>}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
