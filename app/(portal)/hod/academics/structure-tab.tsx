"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { createProgramme, createSection, getDepartmentStructure, setSectionStatus } from "./actions";

/**
 * Department academic configuration (decision 5). It belongs to the
 * department: a replacement HOD finds it here unchanged. The database keeps
 * history-bearing structure from being rewritten (a section with students or
 * offerings cannot change its programme or intake year, a programme cannot
 * be deleted by an HOD, nothing moves to another department) and audits
 * every change.
 */
const DEGREES = [
  { value: "undergraduate", label: "Undergraduate" },
  { value: "postgraduate", label: "Postgraduate" },
  { value: "diploma", label: "Diploma" },
  { value: "doctoral", label: "Doctoral" },
  { value: "certificate", label: "Certificate" },
];

export function StructureTab({ departmentId }: { departmentId: string }) {
  const structure = useAsyncResource(() => getDepartmentStructure(departmentId), [departmentId]);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [programme, setProgramme] = useState({ name: "", code: "", degreeType: "undergraduate", durationSemesters: "8", totalCredits: "" });
  const [section, setSection] = useState({ programmeId: "", name: "", batchYear: String(new Date().getFullYear()), capacity: "" });

  const run = async (action: () => Promise<void>, done: string, fallback: string) => {
    setPending(true);
    setError(null);
    try {
      await action();
      setNotice(done);
      structure.reload();
      return true;
    } catch (e) {
      setError(await toFeedbackError(e, fallback));
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-lg">
      <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>
      <ErrorAlert error={error} />
      <StateView state={structure} isEmpty={() => false} loadingLabel="Loading the department's structure…" empty={{ title: "Nothing to show" }}>
        {(data) => (
          <>
            <section aria-labelledby="programmes-heading" className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm">
              <h2 id="programmes-heading" className="text-sm font-bold text-on-surface">Programmes and sections</h2>
              {data.programmes.length === 0 ? (
                <p className="text-sm text-on-surface-variant">No programme yet. A department configured for the first time starts by adding its programmes below.</p>
              ) : (
                <ul className="space-y-md">
                  {data.programmes.map((p) => (
                    <li key={p.id} className="rounded-xl border border-outline-variant p-md">
                      <div className="flex flex-wrap items-center justify-between gap-sm">
                        <p className="text-sm font-semibold text-on-surface">{p.name} <span className="text-on-surface-variant">({p.code})</span></p>
                        <StatusBadge status={p.status} />
                      </div>
                      <p className="text-xs text-on-surface-variant">{p.duration_semesters} semesters{p.total_credits ? ` · ${p.total_credits} credits` : ""}</p>
                      <ul className="mt-sm flex flex-wrap gap-sm">
                        {data.sections.filter((s) => s.programme_id === p.id).map((s) => (
                          <li key={s.id} className="flex items-center gap-xs rounded-lg bg-surface-container-low px-sm py-xs text-xs text-on-surface">
                            <span>{s.name} · {s.batch_year}{s.status === "inactive" ? " (inactive)" : ""}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => void run(
                                () => setSectionStatus(s.id, s.status === "active" ? "inactive" : "active"),
                                s.status === "active" ? `Section ${s.name} deactivated.` : `Section ${s.name} reactivated.`,
                                "The section could not be changed."
                              )}
                            >
                              {s.status === "active" ? "Deactivate" : "Reactivate"}<span className="sr-only"> section {s.name} {s.batch_year}</span>
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="grid grid-cols-1 gap-lg lg:grid-cols-2">
              <form
                aria-labelledby="add-programme-heading"
                className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => createProgramme(departmentId, {
                    name: programme.name,
                    code: programme.code,
                    degreeType: programme.degreeType as "undergraduate",
                    durationSemesters: Number(programme.durationSemesters),
                    totalCredits: programme.totalCredits ? Number(programme.totalCredits) : null,
                  }), `Programme ${programme.name} added.`, "The programme could not be added.").then((ok) => {
                    if (ok) setProgramme({ name: "", code: "", degreeType: "undergraduate", durationSemesters: "8", totalCredits: "" });
                  });
                }}
              >
                <h2 id="add-programme-heading" className="text-sm font-bold text-on-surface">Add a programme</h2>
                <FormField label="Name" id="programme-name" value={programme.name} onChange={(v) => setProgramme({ ...programme, name: v })} placeholder="B.Tech Computer Science" required />
                <FormField label="Code" id="programme-code" value={programme.code} onChange={(v) => setProgramme({ ...programme, code: v })} placeholder="BTECH-CSE" required />
                <FormField label="Degree" id="programme-degree" type="select" value={programme.degreeType} onChange={(v) => setProgramme({ ...programme, degreeType: v })} options={DEGREES} required />
                <div className="grid grid-cols-2 gap-md">
                  <FormField label="Semesters" id="programme-duration" type="number" value={programme.durationSemesters} onChange={(v) => setProgramme({ ...programme, durationSemesters: v })} required />
                  <FormField label="Total credits" id="programme-credits" type="number" value={programme.totalCredits} onChange={(v) => setProgramme({ ...programme, totalCredits: v })} />
                </div>
                <Button type="submit" disabled={pending || !programme.name || !programme.code}>Add programme</Button>
              </form>

              <form
                aria-labelledby="add-section-heading"
                className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => createSection(section.programmeId, {
                    name: section.name,
                    batchYear: Number(section.batchYear),
                    capacity: section.capacity ? Number(section.capacity) : null,
                  }), `Section ${section.name} added.`, "The section could not be added.").then((ok) => {
                    if (ok) setSection({ ...section, name: "", capacity: "" });
                  });
                }}
              >
                <h2 id="add-section-heading" className="text-sm font-bold text-on-surface">Add a section</h2>
                <FormField
                  label="Programme"
                  id="section-programme"
                  type="select"
                  value={section.programmeId}
                  onChange={(v) => setSection({ ...section, programmeId: v })}
                  options={data.programmes.filter((p) => p.status === "active").map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }))}
                  required
                />
                <div className="grid grid-cols-2 gap-md">
                  <FormField label="Section name" id="section-name" value={section.name} onChange={(v) => setSection({ ...section, name: v })} placeholder="A" required />
                  <FormField label="Intake year" id="section-batch" type="number" value={section.batchYear} onChange={(v) => setSection({ ...section, batchYear: v })} required />
                </div>
                <FormField label="Capacity" id="section-capacity" type="number" value={section.capacity} onChange={(v) => setSection({ ...section, capacity: v })} />
                <Button type="submit" disabled={pending || !section.programmeId || !section.name}>Add section</Button>
              </form>
            </div>
          </>
        )}
      </StateView>
    </div>
  );
}
