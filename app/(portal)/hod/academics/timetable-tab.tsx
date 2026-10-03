"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, FormField } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { TimetableWeek } from "@/components/academics/timetable-week";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { DAY_NAMES } from "@/lib/academic/timetable";
import { createTimetableSlot, deleteTimetableSlot, getTimetableWorkspace } from "./actions";

/**
 * Scheduling the department's offerings for the active term (decision 6).
 * The database refuses a teacher, section or room double-booking and any
 * change to a closed term's timetable, and says which class is in the way.
 */
const DAYS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: DAY_NAMES[d] }));

export function TimetableTab({ departmentId }: { departmentId: string }) {
  const workspace = useAsyncResource(() => getTimetableWorkspace(departmentId), [departmentId]);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState({ offeringId: "", day: "1", start: "09:00", end: "10:00", room: "" });

  const run = async (key: string, action: () => Promise<void>, done: string, fallback: string) => {
    setPending(key);
    setError(null);
    try {
      await action();
      setNotice(done);
      workspace.reload();
      return true;
    } catch (e) {
      setError(await toFeedbackError(e, fallback));
      return false;
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-lg">
      <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>
      <ErrorAlert error={error} />
      <StateView state={workspace} isEmpty={() => false} loadingLabel="Loading the timetable…" empty={{ title: "Nothing to show" }}>
        {(data) => (
          <>
            <form
              aria-labelledby="add-class-heading"
              className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void run("new", () => createTimetableSlot({
                  offeringId: draft.offeringId,
                  day: Number(draft.day),
                  start: draft.start,
                  end: draft.end,
                  room: draft.room.trim() || null,
                }), "Class scheduled.", "The class could not be scheduled.");
              }}
            >
              <h2 id="add-class-heading" className="text-sm font-bold text-on-surface">Schedule a class</h2>
              {data.offerings.length === 0 ? (
                <p className="text-sm text-on-surface-variant">There is no open offering of this department&apos;s courses in the active term to schedule.</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-5">
                    <div className="sm:col-span-2">
                      <FormField
                        label="Offering"
                        id="slot-offering"
                        type="select"
                        value={draft.offeringId}
                        onChange={(v) => setDraft({ ...draft, offeringId: v })}
                        options={data.offerings.map((o) => ({ value: o.id, label: `${o.course.code} · ${o.section.label}${o.instructor ? ` · ${o.instructor.full_name}` : " · no teacher"}` }))}
                        required
                      />
                    </div>
                    <FormField label="Day" id="slot-day" type="select" value={draft.day} onChange={(v) => setDraft({ ...draft, day: v })} options={DAYS} required />
                    <FormField label="Starts" id="slot-start" type="time" value={draft.start} onChange={(v) => setDraft({ ...draft, start: v })} required />
                    <FormField label="Ends" id="slot-end" type="time" value={draft.end} onChange={(v) => setDraft({ ...draft, end: v })} required />
                  </div>
                  <div className="max-w-xs">
                    <FormField label="Room" id="slot-room" value={draft.room} onChange={(v) => setDraft({ ...draft, room: v })} placeholder="R-101" />
                  </div>
                  <Button type="submit" disabled={pending === "new" || !draft.offeringId}>Schedule class</Button>
                </>
              )}
            </form>

            <section aria-labelledby="week-heading" className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm">
              <h2 id="week-heading" className="text-sm font-bold text-on-surface">This term&apos;s week</h2>
              <TimetableWeek
                slots={data.slots}
                pendingSlotId={pending}
                onRemove={(id) => void run(id, () => deleteTimetableSlot(id), "Class removed from the timetable.", "The class could not be removed.")}
              />
            </section>
          </>
        )}
      </StateView>
    </div>
  );
}
