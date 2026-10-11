"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import {
  createAcademicYear,
  createSemester,
  updateSemester,
  transitionSemester,
  transitionAcademicYear,
  deleteSemester,
} from "./actions";

type Semester = {
  id: string;
  name: string;
  sequence_no: number | null;
  start_date: string;
  end_date: string;
  status: "planned" | "active" | "closed";
};

type AcademicYear = {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: "planned" | "active" | "closed";
  semesters: Semester[];
};

const EMPTY_YEAR = { name: "", startDate: "", endDate: "" };
const EMPTY_SEMESTER = { name: "", sequenceNo: "1", startDate: "", endDate: "" };

/**
 * The lifecycle is planned -> active -> closed, forward only, and the
 * database refuses anything else (047 §7k). The buttons offered here are the
 * moves that are legal from the row's current status; the server re-checks
 * every one of them, so a stale page produces a clear error, not a wrong
 * write.
 */
export default function AdminAcademicPeriods() {
  const supabase = createClient();
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // An irreversible move (close, delete), asked first.
  const [confirming, setConfirming] = useState<{
    key: string;
    title: string;
    description: string;
    confirmLabel: string;
    done: string;
    action: () => Promise<unknown>;
  } | null>(null);

  const [showYear, setShowYear] = useState(false);
  const [yearForm, setYearForm] = useState(EMPTY_YEAR);

  const [semesterYear, setSemesterYear] = useState<AcademicYear | null>(null);
  const [semesterForm, setSemesterForm] = useState(EMPTY_SEMESTER);

  const [editing, setEditing] = useState<Semester | null>(null);
  const [editForm, setEditForm] = useState({ name: "", startDate: "", endDate: "" });

  // A failed load is an error — never "No semester is active", which would
  // misstate the college's calendar (owner decision D5).
  const yearsResource = useAsyncResource(async () => {
    const data = requireRows(
      await supabase
        .from("academic_years")
        .select("id, name, start_date, end_date, status, semesters(id, name, sequence_no, start_date, end_date, status)")
        .order("start_date", { ascending: false })
    );
    return (data as unknown as AcademicYear[]).map((y) => ({
      ...y,
      semesters: [...(y.semesters || [])].sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0)),
    }));
  }, []);
  const years = yearsResource.data ?? [];

  /** Runs one mutation; reloading afterwards reports its own failure, never as a failed change. */
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    if (busy) return false;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      yearsResource.reload();
      return true;
    } catch (e) {
      setError(await toFeedbackError(e, "The change was not saved."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const dialogOpen = showYear || semesterYear !== null || editing !== null || confirming !== null;

  const handleCreateYear = async () => {
    if (await run("year", () => createAcademicYear(yearForm), `Academic year ${yearForm.name} created.`)) {
      setYearForm(EMPTY_YEAR);
      setShowYear(false);
    }
  };

  const handleCreateSemester = async () => {
    if (!semesterYear) return;
    const ok = await run(
      "semester",
      () =>
        createSemester({
          academicYearId: semesterYear.id,
          name: semesterForm.name,
          sequenceNo: Number(semesterForm.sequenceNo),
          startDate: semesterForm.startDate,
          endDate: semesterForm.endDate,
        }),
      `Semester ${semesterForm.name} created.`
    );
    if (ok) {
      setSemesterForm(EMPTY_SEMESTER);
      setSemesterYear(null);
    }
  };

  const handleUpdateSemester = async () => {
    if (!editing) return;
    if (await run(editing.id, () => updateSemester({ semesterId: editing.id, ...editForm }), `${editForm.name} saved.`)) {
      setEditing(null);
    }
  };

  const activeSemester = years.flatMap((y) => y.semesters).find((s) => s.status === "active");

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Academic Periods</h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Academic years and the semesters inside them. One semester is active at a time; course offerings,
            attendance and marks attach to it.
          </p>
        </div>
        <Button onClick={() => setShowYear(true)}>+ Academic Year</Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* An open dialog shows its own failure. */}
      <ErrorAlert error={!dialogOpen ? error : null} />

      <StateView state={yearsResource} isEmpty={() => false} loadingLabel="Loading academic periods…" empty={{ title: "No academic years yet" }}>
        {() => (
          <>
      {activeSemester ? (
        <div className="bg-success-container border border-success/30 rounded-xl p-md text-sm">
          <span className="font-semibold text-on-surface">Current semester:</span>{" "}
          <span className="text-on-surface-variant">
            {activeSemester.name} · {activeSemester.start_date} → {activeSemester.end_date}
          </span>
        </div>
      ) : (
        <div className="bg-surface-container-low border border-outline-variant rounded-xl p-md text-sm text-on-surface-variant">
          No semester is active. Teachers cannot be assigned offerings until one is.
        </div>
      )}

      {years.length === 0 && (
        <div className="text-sm text-on-surface-variant">No academic years yet. Create one to begin.</div>
      )}

      <div className="space-y-md">
        {years.map((year) => (
          <section key={year.id} className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
            <header className="flex items-center justify-between gap-md px-lg py-md bg-surface-container-low">
              <div className="flex items-center gap-md">
                <h2 className="text-lg font-bold text-on-surface">{year.name}</h2>
                <StatusBadge status={year.status} />
                <span className="text-xs text-on-surface-variant">
                  {year.start_date ?? "—"} → {year.end_date ?? "—"}
                </span>
              </div>
              <div className="flex items-center gap-xs">
                {year.status !== "closed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSemesterForm(EMPTY_SEMESTER);
                      setSemesterYear(year);
                    }}
                  >
                    + Semester
                  </Button>
                )}
                {year.status === "planned" && (
                  <Button size="sm" disabled={busy === year.id} aria-busy={busy === year.id || undefined} onClick={() => run(year.id, () => transitionAcademicYear(year.id, "activate"), `${year.name} activated.`)}>
                    Activate year
                  </Button>
                )}
                {year.status === "active" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === year.id}
                    onClick={() => {
                      setError(null);
                      setConfirming({
                        key: year.id,
                        title: `Close ${year.name}?`,
                        description: "Closing is final: a closed academic year cannot be reopened or changed.",
                        confirmLabel: "Close year",
                        done: `${year.name} closed.`,
                        action: () => transitionAcademicYear(year.id, "close"),
                      });
                    }}
                  >
                    Close year
                  </Button>
                )}
              </div>
            </header>

            {year.semesters.length === 0 ? (
              <p className="px-lg py-md text-sm text-on-surface-variant">No semesters in this year.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-on-surface-variant">
                  <tr>
                    <th className="text-left px-lg py-sm font-semibold">#</th>
                    <th className="text-left px-md py-sm font-semibold">Semester</th>
                    <th className="text-left px-md py-sm font-semibold">Dates</th>
                    <th className="text-left px-md py-sm font-semibold">Status</th>
                    <th className="text-right px-lg py-sm font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {year.semesters.map((s) => (
                    <tr key={s.id} className="border-t border-outline-variant/60">
                      <td className="px-lg py-sm font-mono text-on-surface-variant">{s.sequence_no ?? "—"}</td>
                      <td className="px-md py-sm font-medium text-on-surface">{s.name}</td>
                      <td className="px-md py-sm text-on-surface-variant">
                        {s.start_date} → {s.end_date}
                      </td>
                      <td className="px-md py-sm">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="px-lg py-sm">
                        <div className="flex justify-end gap-xs">
                          {s.status !== "closed" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditing(s);
                                setEditForm({ name: s.name, startDate: s.start_date, endDate: s.end_date });
                              }}
                            >
                              Edit
                            </Button>
                          )}
                          {s.status === "planned" && (
                            <>
                              <Button size="sm" disabled={busy === s.id} aria-busy={busy === s.id || undefined} onClick={() => run(s.id, () => transitionSemester(s.id, "activate"), `${s.name} activated.`)}>
                                Activate
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={busy === s.id}
                                onClick={() => {
                                  setError(null);
                                  setConfirming({
                                    key: s.id,
                                    title: `Delete ${s.name}?`,
                                    description: "The semester is removed. This cannot be undone.",
                                    confirmLabel: "Delete semester",
                                    done: `${s.name} deleted.`,
                                    action: () => deleteSemester(s.id),
                                  });
                                }}
                              >
                                Delete
                              </Button>
                            </>
                          )}
                          {s.status === "active" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy === s.id}
                              onClick={() => {
                                setError(null);
                                setConfirming({
                                  key: s.id,
                                  title: `Close ${s.name}?`,
                                  description: "Closing is final: attendance and marks for a closed semester can no longer be recorded.",
                                  confirmLabel: "Close semester",
                                  done: `${s.name} closed.`,
                                  action: () => transitionSemester(s.id, "close"),
                                });
                              }}
                            >
                              Close
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
          </>
        )}
      </StateView>

      <Modal
        open={showYear}
        onClose={() => setShowYear(false)}
        title="New Academic Year"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowYear(false)}>Cancel</Button>
            <Button onClick={handleCreateYear} disabled={busy === "year"} aria-busy={busy === "year" || undefined}>{busy === "year" ? "Creating..." : "Create"}</Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField label="Name" id="ay_name" value={yearForm.name} onChange={(v) => setYearForm({ ...yearForm, name: v })} placeholder="e.g. 2027-28" required />
          <FormField label="Start date" id="ay_start" type="date" value={yearForm.startDate} onChange={(v) => setYearForm({ ...yearForm, startDate: v })} required />
          <FormField label="End date" id="ay_end" type="date" value={yearForm.endDate} onChange={(v) => setYearForm({ ...yearForm, endDate: v })} required />
        </div>
      </Modal>

      <Modal
        open={semesterYear !== null}
        onClose={() => setSemesterYear(null)}
        title={semesterYear ? `New Semester in ${semesterYear.name}` : "New Semester"}
        footer={
          <>
            <Button variant="outline" onClick={() => setSemesterYear(null)}>Cancel</Button>
            <Button onClick={handleCreateSemester} disabled={busy === "semester"} aria-busy={busy === "semester" || undefined}>{busy === "semester" ? "Creating..." : "Create"}</Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField label="Name" id="sem_name" value={semesterForm.name} onChange={(v) => setSemesterForm({ ...semesterForm, name: v })} placeholder="e.g. Odd Term 2027" required />
          <FormField label="Order within the year" id="sem_seq" type="number" value={semesterForm.sequenceNo} onChange={(v) => setSemesterForm({ ...semesterForm, sequenceNo: v })} required />
          <FormField label="Start date" id="sem_start" type="date" value={semesterForm.startDate} onChange={(v) => setSemesterForm({ ...semesterForm, startDate: v })} required />
          <FormField label="End date" id="sem_end" type="date" value={semesterForm.endDate} onChange={(v) => setSemesterForm({ ...semesterForm, endDate: v })} required />
        </div>
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : "Edit Semester"}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={handleUpdateSemester} disabled={busy === editing?.id} aria-busy={busy === editing?.id || undefined}>Save</Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField label="Name" id="edit_name" value={editForm.name} onChange={(v) => setEditForm({ ...editForm, name: v })} required />
          <FormField label="Start date" id="edit_start" type="date" value={editForm.startDate} onChange={(v) => setEditForm({ ...editForm, startDate: v })} required />
          <FormField label="End date" id="edit_end" type="date" value={editForm.endDate} onChange={(v) => setEditForm({ ...editForm, endDate: v })} required />
        </div>
      </Modal>

      <ConfirmationDialog
        open={confirming !== null}
        title={confirming?.title ?? ""}
        description={confirming?.description}
        confirmLabel={confirming?.confirmLabel ?? "Confirm"}
        pending={confirming !== null && busy === confirming.key}
        error={confirming !== null ? error : null}
        onConfirm={async () => {
          if (!confirming) return;
          if (await run(confirming.key, confirming.action, confirming.done)) setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
