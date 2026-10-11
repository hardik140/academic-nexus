"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { formatDate } from "@/lib/format";
import {
  createOffering, getOfferingsWorkspace, grantExternalTeaching, revokeExternalTeaching, setOfferingInstructor,
} from "./actions";

/**
 * Teacher → course → section assignment for a term (decision 4). The
 * offering is the authoritative relationship. A teacher of another
 * department can be assigned only after this department authorizes them —
 * the database refuses any other cross-department assignment.
 */
export function OfferingsTab({ departmentId }: { departmentId: string }) {
  const workspace = useAsyncResource(() => getOfferingsWorkspace(departmentId), [departmentId]);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState({ semesterId: "", courseId: "", sectionId: "", instructorId: "" });
  const [teacherPick, setTeacherPick] = useState<Record<string, string>>({});
  const [grant, setGrant] = useState({ teacherId: "", reason: "" });
  const [revokeReason, setRevokeReason] = useState<Record<string, string>>({});

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
      <StateView state={workspace} isEmpty={() => false} loadingLabel="Loading teacher assignments…" empty={{ title: "Nothing to show" }}>
        {(data) => {
          const teacherOptions = data.teachers.map((t) => ({ value: t.id, label: t.external ? `${t.full_name} (authorized from another department)` : t.full_name }));
          return (
            <>
              <section aria-labelledby="offerings-heading" className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm">
                <h2 id="offerings-heading" className="text-sm font-bold text-on-surface">Course offerings and teachers</h2>
                {data.offerings.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">No offering of this department&apos;s courses in an open term yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Offerings of the department&apos;s courses in open terms</caption>
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-on-surface-variant">
                          <th scope="col" className="px-md py-sm">Course</th>
                          <th scope="col" className="px-md py-sm">Section</th>
                          <th scope="col" className="px-md py-sm">Term</th>
                          <th scope="col" className="px-md py-sm">Teacher</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant">
                        {data.offerings.map((o) => {
                          const choice = teacherPick[o.id] ?? "";
                          const editable = o.status === "planned" || o.status === "active";
                          return (
                            <tr key={o.id}>
                              <th scope="row" className="px-md py-sm text-left font-semibold text-on-surface">{o.course.code} — {o.course.name}</th>
                              <td className="px-md py-sm text-on-surface-variant">{o.section.label}</td>
                              <td className="px-md py-sm"><span className="text-on-surface-variant">{o.semester.name}</span> <StatusBadge status={o.status} /></td>
                              <td className="px-md py-sm">
                                <p className={o.instructor ? "text-on-surface" : "font-semibold text-error"}>{o.instructor?.full_name ?? "No teacher"}</p>
                                {editable && (
                                  <div className="mt-xs flex flex-wrap items-center gap-sm">
                                    <label htmlFor={`teacher-${o.id}`} className="sr-only">Teacher for {o.course.code} {o.section.label}</label>
                                    <select
                                      id={`teacher-${o.id}`}
                                      value={choice}
                                      onChange={(e) => setTeacherPick({ ...teacherPick, [o.id]: e.target.value })}
                                      className="rounded-xl border border-border-control bg-surface-container-low px-md py-xs text-sm text-on-surface"
                                    >
                                      <option value="">Change teacher…</option>
                                      {teacherOptions.filter((t) => t.value !== o.instructor?.id).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    </select>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={!choice || pending === o.id}
                                      aria-busy={pending === o.id || undefined}
                                      onClick={() => void run(o.id, () => setOfferingInstructor(o.id, choice), "Teacher assigned.", "The teacher could not be assigned.")}
                                    >
                                      {pending === o.id ? "Saving…" : "Assign"}
                                    </Button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <form
                aria-labelledby="new-offering-heading"
                className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("new", () => createOffering({
                    semesterId: draft.semesterId,
                    courseId: draft.courseId,
                    sectionId: draft.sectionId,
                    instructorId: draft.instructorId || null,
                  }), "Offering created. Students of the section are enrolled when the term is running.", "The offering could not be created.").then((ok) => {
                    if (ok) setDraft({ ...draft, courseId: "", sectionId: "", instructorId: "" });
                  });
                }}
              >
                <h2 id="new-offering-heading" className="text-sm font-bold text-on-surface">Offer a course to a section</h2>
                <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
                  <FormField label="Term" id="offering-term" type="select" value={draft.semesterId} onChange={(v) => setDraft({ ...draft, semesterId: v })} options={data.terms.map((t) => ({ value: t.id, label: `${t.name} (${t.status})` }))} required />
                  <FormField label="Course" id="offering-course" type="select" value={draft.courseId} onChange={(v) => setDraft({ ...draft, courseId: v })} options={data.courses.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}${c.type === "elective" ? " (elective)" : ""}` }))} required />
                  <FormField label="Section" id="offering-section" type="select" value={draft.sectionId} onChange={(v) => setDraft({ ...draft, sectionId: v })} options={data.sections.map((s) => ({ value: s.id, label: s.label }))} required />
                  <FormField label="Teacher (optional)" id="offering-teacher" type="select" value={draft.instructorId} onChange={(v) => setDraft({ ...draft, instructorId: v })} options={teacherOptions} />
                </div>
                <Button type="submit" disabled={pending === "new" || !draft.semesterId || !draft.courseId || !draft.sectionId}>Create offering</Button>
              </form>

              <section aria-labelledby="external-heading" className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm">
                <div>
                  <h2 id="external-heading" className="text-sm font-bold text-on-surface">Teachers from other departments</h2>
                  <p className="mt-xs text-sm text-on-surface-variant">
                    A teacher of another department can teach this department&apos;s courses only after you authorize them here.
                  </p>
                </div>
                {data.external.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">No external teacher is authorized.</p>
                ) : (
                  <ul className="divide-y divide-outline-variant rounded-xl border border-outline-variant">
                    {data.external.map((a) => (
                      <li key={a.id} className="space-y-sm px-md py-sm">
                        <p className="text-sm font-semibold text-on-surface">{a.full_name}{a.home_department ? ` · ${a.home_department}` : ""}</p>
                        <p className="text-xs text-on-surface-variant">Authorized {formatDate(a.granted_at)} — {a.reason}</p>
                        <div className="flex flex-wrap items-end gap-sm">
                          <div className="min-w-[16rem] flex-1">
                            <FormField label="Reason for revoking" id={`revoke-${a.id}`} value={revokeReason[a.id] ?? ""} onChange={(v) => setRevokeReason({ ...revokeReason, [a.id]: v })} />
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={(revokeReason[a.id] ?? "").trim().length < 10 || pending === a.id}
                            onClick={() => void run(a.id, () => revokeExternalTeaching(a.id, revokeReason[a.id] ?? ""), `${a.full_name}'s authorization was revoked.`, "The authorization could not be revoked.")}
                          >
                            Revoke<span className="sr-only"> {a.full_name}</span>
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="grid grid-cols-1 gap-md sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run("grant", () => grantExternalTeaching(departmentId, grant.teacherId, grant.reason), "Teacher authorized.", "The teacher could not be authorized.").then((ok) => {
                      if (ok) setGrant({ teacherId: "", reason: "" });
                    });
                  }}
                >
                  <FormField label="Teacher" id="grant-teacher" type="select" value={grant.teacherId} onChange={(v) => setGrant({ ...grant, teacherId: v })} options={data.externalCandidates.map((t) => ({ value: t.id, label: t.full_name }))} required />
                  <FormField label="Reason" id="grant-reason" value={grant.reason} onChange={(v) => setGrant({ ...grant, reason: v })} placeholder="Teaches Engineering Mathematics for us" required />
                  <div>
                    <Button type="submit" disabled={pending === "grant" || !grant.teacherId || grant.reason.trim().length < 10}>Authorize teacher</Button>
                  </div>
                </form>
              </section>
            </>
          );
        }}
      </StateView>
    </div>
  );
}
