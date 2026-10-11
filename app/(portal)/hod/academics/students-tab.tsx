"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, FormField } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { getUnplacedStudents, placeStudentInSection } from "./actions";

/**
 * Students of the department with no current section — the explicit
 * reconciliation the contract requires instead of guessing (§4). Placing a
 * student opens their section and enrols them in its current classes. A
 * student who already has a section changes it only through a section change
 * request (PR 2), never here.
 */
export function StudentsTab({ departmentId }: { departmentId: string }) {
  const workspace = useAsyncResource(() => getUnplacedStudents(departmentId), [departmentId]);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, { sectionId: string; reason: string }>>({});

  const place = async (studentId: string, name: string) => {
    const pick = picks[studentId];
    if (!pick) return;
    setPending(studentId);
    setError(null);
    try {
      await placeStudentInSection(studentId, pick.sectionId, pick.reason);
      setNotice(`${name} was placed in their section and enrolled in its classes.`);
      workspace.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "The student could not be placed."));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-lg">
      <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>
      <ErrorAlert error={error} />
      <StateView
        state={workspace}
        isEmpty={(d) => d.students.length === 0}
        loadingLabel="Loading students without a section…"
        empty={{ title: "Every student has a section", description: "Students of your department who are not yet in a section would be listed here." }}
      >
        {(data) => (
          <section aria-labelledby="unplaced-heading" className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm">
            <h2 id="unplaced-heading" className="text-sm font-bold text-on-surface">Students without a section ({data.students.length})</h2>
            <ul className="divide-y divide-outline-variant">
              {data.students.map((s) => {
                const pick = picks[s.student_id] ?? { sectionId: "", reason: "" };
                const name = s.full_name ?? s.enrollment_number;
                return (
                  <li key={s.student_id} className="space-y-sm py-md">
                    <p className="text-sm font-semibold text-on-surface">{name}</p>
                    <p className="text-xs text-on-surface-variant">{s.enrollment_number} · intake {s.batch_year} · semester {s.semester} · {s.status}</p>
                    <div className="grid grid-cols-1 gap-sm sm:grid-cols-3 sm:items-end">
                      <FormField
                        label="Section"
                        id={`place-section-${s.student_id}`}
                        type="select"
                        value={pick.sectionId}
                        onChange={(v) => setPicks({ ...picks, [s.student_id]: { ...pick, sectionId: v } })}
                        options={data.sections.map((x) => ({ value: x.id, label: x.label }))}
                      />
                      <FormField
                        label="Reason"
                        id={`place-reason-${s.student_id}`}
                        value={pick.reason}
                        onChange={(v) => setPicks({ ...picks, [s.student_id]: { ...pick, reason: v } })}
                        placeholder="Admitted to section A in 2024"
                      />
                      <div>
                        <Button
                          disabled={!pick.sectionId || pick.reason.trim().length < 10 || pending === s.student_id}
                          aria-busy={pending === s.student_id || undefined}
                          onClick={() => void place(s.student_id, name)}
                        >
                          {pending === s.student_id ? "Placing…" : <>Place<span className="sr-only"> {name}</span></>}
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </StateView>
    </div>
  );
}
