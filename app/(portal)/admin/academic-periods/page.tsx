"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
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
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [showYear, setShowYear] = useState(false);
  const [yearForm, setYearForm] = useState(EMPTY_YEAR);

  const [semesterYear, setSemesterYear] = useState<AcademicYear | null>(null);
  const [semesterForm, setSemesterForm] = useState(EMPTY_SEMESTER);

  const [editing, setEditing] = useState<Semester | null>(null);
  const [editForm, setEditForm] = useState({ name: "", startDate: "", endDate: "" });

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("academic_years")
      .select("id, name, start_date, end_date, status, semesters(id, name, sequence_no, start_date, end_date, status)")
      .order("start_date", { ascending: false });
    setYears(
      ((data as unknown as AcademicYear[]) || []).map((y) => ({
        ...y,
        semesters: [...(y.semesters || [])].sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0)),
      }))
    );
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  /** Runs one mutation, reloads, and turns a thrown message into the banner. */
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change was not saved.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleCreateYear = async () => {
    if (await run("year", () => createAcademicYear(yearForm))) {
      setYearForm(EMPTY_YEAR);
      setShowYear(false);
    }
  };

  const handleCreateSemester = async () => {
    if (!semesterYear) return;
    const ok = await run("semester", () =>
      createSemester({
        academicYearId: semesterYear.id,
        name: semesterForm.name,
        sequenceNo: Number(semesterForm.sequenceNo),
        startDate: semesterForm.startDate,
        endDate: semesterForm.endDate,
      })
    );
    if (ok) {
      setSemesterForm(EMPTY_SEMESTER);
      setSemesterYear(null);
    }
  };

  const handleUpdateSemester = async () => {
    if (!editing) return;
    if (await run(editing.id, () => updateSemester({ semesterId: editing.id, ...editForm }))) {
      setEditing(null);
    }
  };

  const activeSemester = years.flatMap((y) => y.semesters).find((s) => s.status === "active");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
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

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {activeSemester ? (
        <div className="bg-success/10 border border-success/20 rounded-xl p-md text-sm">
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
                  <Button size="sm" disabled={busy === year.id} onClick={() => run(year.id, () => transitionAcademicYear(year.id, "activate"))}>
                    Activate year
                  </Button>
                )}
                {year.status === "active" && (
                  <Button size="sm" variant="secondary" disabled={busy === year.id} onClick={() => run(year.id, () => transitionAcademicYear(year.id, "close"))}>
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
                              <Button size="sm" disabled={busy === s.id} onClick={() => run(s.id, () => transitionSemester(s.id, "activate"))}>
                                Activate
                              </Button>
                              <Button size="sm" variant="destructive" disabled={busy === s.id} onClick={() => run(s.id, () => deleteSemester(s.id))}>
                                Delete
                              </Button>
                            </>
                          )}
                          {s.status === "active" && (
                            <Button size="sm" variant="secondary" disabled={busy === s.id} onClick={() => run(s.id, () => transitionSemester(s.id, "close"))}>
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

      <Modal
        open={showYear}
        onClose={() => setShowYear(false)}
        title="New Academic Year"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowYear(false)}>Cancel</Button>
            <Button onClick={handleCreateYear} disabled={busy === "year"}>{busy === "year" ? "Creating..." : "Create"}</Button>
          </>
        }
      >
        <div className="space-y-md">
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
            <Button onClick={handleCreateSemester} disabled={busy === "semester"}>{busy === "semester" ? "Creating..." : "Create"}</Button>
          </>
        }
      >
        <div className="space-y-md">
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
            <Button onClick={handleUpdateSemester} disabled={busy === editing?.id}>Save</Button>
          </>
        }
      >
        <div className="space-y-md">
          <FormField label="Name" id="edit_name" value={editForm.name} onChange={(v) => setEditForm({ ...editForm, name: v })} required />
          <FormField label="Start date" id="edit_start" type="date" value={editForm.startDate} onChange={(v) => setEditForm({ ...editForm, startDate: v })} required />
          <FormField label="End date" id="edit_end" type="date" value={editForm.endDate} onChange={(v) => setEditForm({ ...editForm, endDate: v })} required />
        </div>
      </Modal>
    </div>
  );
}
