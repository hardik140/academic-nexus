"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { StateView } from "@/components/ui/state-view";
import { StudentInviteForm, type StudentInviteValues } from "@/components/academics/student-invite-form";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { getMyClasses, inviteStudentToMyClass } from "./actions";

/**
 * The Class In-Charge's class (migration 055): the sections the HOD made
 * this teacher In-Charge of for the active term, their students, and an
 * invitation form fixed to that section.
 */
export default function TeacherClassPage() {
  const classes = useAsyncResource(() => getMyClasses(), []);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ section: string; error: FeedbackError } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const invite = async (sectionId: string, values: StudentInviteValues) => {
    setPending(sectionId);
    setError(null);
    try {
      const { sectionLabel } = await inviteStudentToMyClass(values);
      setNotice(`Invitation sent to ${values.email} for ${sectionLabel}.`);
      setFormKey((k) => k + 1);
      classes.reload();
    } catch (e) {
      setError({ section: sectionId, error: await toFeedbackError(e, "The invitation could not be sent.") });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My class</h1>
        <p className="mt-xs text-sm text-on-surface-variant">The sections you are Class In-Charge of this term.</p>
      </div>
      <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>
      <StateView
        state={classes}
        isEmpty={(d) => d.classes.length === 0}
        loadingLabel="Loading your class…"
        empty={{ title: "You are not a Class In-Charge this term", description: "Your HOD assigns a Class In-Charge to each section." }}
      >
        {(data) => (
          <div className="space-y-lg">
            {data.classes.map((c) => (
              <section key={c.section_id} aria-labelledby={`class-${c.section_id}`} className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm">
                <div>
                  <h2 id={`class-${c.section_id}`} className="text-sm font-bold text-on-surface">{c.label}</h2>
                  <p className="text-xs text-on-surface-variant">{data.term} · {c.students.length} student{c.students.length === 1 ? "" : "s"}</p>
                </div>
                {c.students.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">No student is in this section yet.</p>
                ) : (
                  <ul className="divide-y divide-outline-variant rounded-xl border border-outline-variant">
                    {c.students.map((s) => (
                      <li key={s.student_id} className="flex flex-wrap justify-between gap-sm px-md py-sm text-sm">
                        <span className="font-semibold text-on-surface">{s.full_name ?? s.enrollment_number}</span>
                        <span className="text-on-surface-variant">{s.enrollment_number} · semester {s.semester}{s.status !== "active" ? ` · ${s.status}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <details className="rounded-xl border border-outline-variant p-md">
                  <summary className="cursor-pointer text-sm font-semibold text-on-surface">Invite a student to {c.label}</summary>
                  <div className="mt-md">
                    <StudentInviteForm
                      key={`${c.section_id}-${formKey}`}
                      idPrefix={`invite-${c.section_id}`}
                      sections={[{ id: c.section_id, label: c.label }]}
                      maxSemester={c.duration_semesters}
                      pending={pending === c.section_id}
                      error={error?.section === c.section_id ? error.error : null}
                      onSubmit={(v) => void invite(c.section_id, v)}
                    />
                  </div>
                </details>
              </section>
            ))}
          </div>
        )}
      </StateView>
    </div>
  );
}
