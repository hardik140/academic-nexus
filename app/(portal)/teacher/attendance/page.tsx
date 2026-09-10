"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, Modal, FormField, StatusBadge } from "@/components/ui/modal";
import { saveAttendance, requestAttendanceCorrection, listMyCorrectionRequests } from "./actions";
import type { Database } from "@/types/database";

type AttendanceStatus = Database["public"]["Tables"]["attendance"]["Row"]["status"];

const CORRECTABLE_STATUSES: AttendanceStatus[] = ["present", "absent", "late", "excused"];

export default function TeacherAttendance() {
  const supabase = createClient();
  // Offerings, not courses: a teacher can hold two sections of one course,
  // and the register belongs to the section — see lib/offerings.ts.
  const [offerings, setOfferings] = useState<any[]>([]);
  // Offering ids this teacher covers as a HOD-assigned substitute rather
  // than as the assigned instructor — used only to label the option.
  const [substituteOfferingIds, setSubstituteOfferingIds] = useState<Set<string>>(new Set());
  const [selectedOffering, setSelectedOffering] = useState<string>("");
  const [students, setStudents] = useState<any[]>([]);
  // Keyed by students.id throughout. course_enrollments.student_id now
  // references students(id) directly (047), so the profiles->students bridge
  // this page used to maintain in three places is gone — along with the bug
  // where it wrote the map under one id space and read it back under the
  // other, silently re-defaulting every student to "present".
  const [attendance, setAttendance] = useState<Record<string, string>>({});
  const [attendanceRecordIds, setAttendanceRecordIds] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  const [myCorrections, setMyCorrections] = useState<any[]>([]);
  const [correctionTarget, setCorrectionTarget] = useState<{ studentId: string; name: string } | null>(null);
  const [correctionForm, setCorrectionForm] = useState({ requestedStatus: "present", reason: "", evidenceNote: "" });
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  useEffect(() => {
    loadOfferings();
    loadMyCorrections();
  }, []);

  const OFFERING_LABEL_COLS =
    "id, status, courses:course_id(id, name, code), sections:section_id(name), semesters:semester_id(name)";

  const loadOfferings = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const [ownRes, substitutionsRes] = await Promise.all([
      supabase.from("course_offerings").select(OFFERING_LABEL_COLS).eq("instructor_id", user.id),
      supabase
        .from("substitution_assignments")
        .select(`course_offerings:offering_id(${OFFERING_LABEL_COLS})`)
        .eq("substitute_teacher_id", user.id)
        .eq("status", "assigned"),
    ]);

    // A cancelled offering has no class to mark; the server refuses the write
    // anyway, so keeping it in the picker would only produce a dead option.
    const own = ((ownRes.data as any[]) || []).filter((o) => o.status !== "cancelled");
    const covered = ((substitutionsRes.data as any[]) || [])
      .map((s) => s.course_offerings)
      .filter((o: any) => o && o.status !== "cancelled" && !own.some((mine) => mine.id === o.id));

    setSubstituteOfferingIds(new Set(covered.map((o: any) => o.id)));
    setOfferings([...own, ...covered]);
  };

  /**
   * "Data Structures · CSE-A · Fall 2026" rather than a bare course name.
   * The teacher may hold two sections of the same course, so the course name
   * alone cannot identify which register is open.
   */
  const offeringLabel = (o: any) => {
    const parts = [
      `${o.courses?.code || ""} — ${o.courses?.name || "Unknown course"}`.trim(),
      o.sections?.name ? `Section ${o.sections.name}` : null,
      o.semesters?.name || null,
    ].filter(Boolean);
    return parts.join(" · ");
  };

  const loadMyCorrections = async () => {
    const data = await listMyCorrectionRequests();
    setMyCorrections(data);
  };

  const loadStudents = async (offeringId: string, forDate: string = date) => {
    setSelectedOffering(offeringId);
    if (!offeringId) {
      setStudents([]);
      setAttendance({});
      setAttendanceRecordIds({});
      return;
    }

    // Enrollment is per OFFERING, so this is the roll for this section in
    // this semester — not everyone who has ever taken the course.
    const { data: enrollments } = await supabase
      .from("course_enrollments")
      .select("student_id, students:student_id(id, enrollment_number, profiles:user_id(full_name, email))")
      .eq("offering_id", offeringId)
      .eq("status", "enrolled");

    const studentList = ((enrollments as any[]) || []).map((e) => ({
      id: e.student_id,
      full_name: e.students?.profiles?.full_name || "Unknown",
      email: e.students?.profiles?.email || "",
      enrollment_number: e.students?.enrollment_number || "",
    }));

    setStudents(studentList);

    const { data: existing } = await supabase
      .from("attendance")
      .select("id, student_id, status")
      .eq("offering_id", offeringId)
      .eq("date", forDate);

    const att: Record<string, string> = {};
    const recIds: Record<string, string> = {};
    studentList.forEach((s) => {
      const record = ((existing as any[]) || []).find((a) => a.student_id === s.id);
      att[s.id] = record?.status || "present";
      if (record) recIds[s.id] = record.id;
    });
    setAttendance(att);
    setAttendanceRecordIds(recIds);
  };

  const toggleStatus = (studentId: string) => {
    const current = attendance[studentId] || "present";
    const cycle = ["present", "absent", "late", "excused"];
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    setAttendance({ ...attendance, [studentId]: next });
  };

  const handleSaveAttendance = async () => {
    setLoading(true);
    setError(null);
    try {
      // The map is already keyed by students.id, which is what the server
      // expects — no id-space translation left to get wrong.
      const entries = students.map((s) => ({
        studentDbId: s.id,
        status: (attendance[s.id] || "present") as AttendanceStatus,
      }));

      await saveAttendance({ offeringId: selectedOffering, date, entries });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await loadStudents(selectedOffering);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save attendance.");
    } finally {
      setLoading(false);
    }
  };

  const openCorrectionModal = (studentId: string, name: string) => {
    setCorrectionTarget({ studentId, name });
    setCorrectionForm({ requestedStatus: attendance[studentId] || "present", reason: "", evidenceNote: "" });
    setCorrectionError(null);
  };

  const submitCorrection = async () => {
    if (!correctionTarget) return;
    const attendanceId = attendanceRecordIds[correctionTarget.studentId];
    if (!attendanceId) return;
    setCorrectionSubmitting(true);
    setCorrectionError(null);
    try {
      await requestAttendanceCorrection({
        attendanceId,
        requestedStatus: correctionForm.requestedStatus as AttendanceStatus,
        reason: correctionForm.reason,
        evidenceNote: correctionForm.evidenceNote || undefined,
      });
      setCorrectionTarget(null);
      await loadMyCorrections();
    } catch (e) {
      setCorrectionError(e instanceof Error ? e.message : "Failed to submit correction request.");
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  const pendingCorrectionAttendanceIds = new Set(
    myCorrections.filter((c: any) => c.status === "pending").map((c: any) => c.attendance_id)
  );

  const statusColors: Record<string, string> = {
    present: "bg-success text-on-success",
    absent: "bg-error text-on-error",
    late: "bg-warning text-on-warning",
    excused: "bg-info text-white",
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Mark Attendance</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Select a class and mark student attendance</p>
      </div>

      {saved && (
        <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">
          ✅ Attendance saved successfully for {date}!
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Live Counts */}
      {selectedOffering && students.length > 0 && (
        <div className="grid grid-cols-3 gap-md">
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
            <div className="text-2xl font-extrabold text-success">{Object.values(attendance).filter(v => v === "present").length}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">Present</div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
            <div className="text-2xl font-extrabold text-error">{Object.values(attendance).filter(v => v === "absent").length}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">Absent</div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
            <div className="text-2xl font-extrabold text-warning">{Object.values(attendance).filter(v => v === "late").length}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">Late</div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-md items-end">
        <div className="space-y-xs">
          <label htmlFor="attendance-offering" className="text-xs font-semibold text-outline uppercase tracking-wider">Class</label>
          <select
            id="attendance-offering"
            value={selectedOffering}
            onChange={(e) => loadStudents(e.target.value)}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none min-w-[280px]"
          >
            <option value="">Select class...</option>
            {offerings.map((o) => (
              <option key={o.id} value={o.id}>
                {offeringLabel(o)}{substituteOfferingIds.has(o.id) ? " (Substitute)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-xs">
          <label htmlFor="attendance-date" className="text-xs font-semibold text-outline uppercase tracking-wider">Date</label>
          <input
            id="attendance-date"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (selectedOffering) loadStudents(selectedOffering, e.target.value);
            }}
            className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
          />
        </div>
        {selectedOffering && students.length > 0 && (
          <Button onClick={handleSaveAttendance} disabled={loading}>
            {loading ? "Saving..." : "Save Attendance"}
          </Button>
        )}
      </div>

      {/* Status Legend */}
      {selectedOffering && (
        <div className="flex gap-sm text-xs">
          <span className="text-outline">Click to toggle:</span>
          {["present", "absent", "late", "excused"].map((s) => (
            <span key={s} className={`px-sm py-xs rounded-full font-semibold capitalize ${statusColors[s]}`}>{s}</span>
          ))}
        </div>
      )}

      {/* Student List */}
      {selectedOffering && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">
              👥 Students ({students.length})
            </h2>
            <div className="flex gap-sm text-xs text-outline">
              <span className="text-success font-semibold">{Object.values(attendance).filter(v => v === "present").length}P</span>
              <span className="text-error font-semibold">{Object.values(attendance).filter(v => v === "absent").length}A</span>
              <span className="text-warning font-semibold">{Object.values(attendance).filter(v => v === "late").length}L</span>
            </div>
          </div>
          <div className="divide-y divide-outline-variant">
            {students.map((s: any, i: number) => {
              const recordId = attendanceRecordIds[s.id];
              const hasPendingCorrection = recordId && pendingCorrectionAttendanceIds.has(recordId);
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
                >
                  <div className="flex items-center gap-sm">
                    <span className="text-xs text-outline w-6 text-right">{i + 1}.</span>
                    <div className="w-8 h-8 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-xs font-bold">
                      {s.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-on-surface">{s.full_name}</div>
                      <div className="text-xs text-outline">{s.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-sm">
                    {recordId && (
                      hasPendingCorrection ? (
                        <span className="text-[11px] font-semibold text-warning">Correction pending</span>
                      ) : (
                        <button
                          className="text-[11px] font-semibold text-secondary hover:underline"
                          onClick={() => openCorrectionModal(s.id, s.full_name)}
                        >
                          Request correction
                        </button>
                      )
                    )}
                    <button
                      className={`px-md py-xs rounded-full text-xs font-bold min-w-[80px] text-center capitalize transition-all ${statusColors[attendance[s.id] || "present"]}`}
                      onClick={() => toggleStatus(s.id)}
                    >
                      {attendance[s.id] || "present"}
                    </button>
                  </div>
                </div>
              );
            })}
            {students.length === 0 && (
              <div className="p-xl text-center text-sm text-outline">
                {selectedOffering ? "No students enrolled in this class." : "Select a class to view students."}
              </div>
            )}
          </div>
        </div>
      )}

      {/* My Correction Requests */}
      {myCorrections.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">My Correction Requests</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {myCorrections.map((c: any) => (
              <div key={c.id} className="flex items-center justify-between px-lg py-md">
                <div>
                  <div className="text-sm font-medium text-on-surface">
                    {c.courses?.code} — {new Date(c.date).toLocaleDateString()}
                  </div>
                  <div className="text-xs text-outline mt-xs">
                    {c.current_status} → {c.requested_status} · &ldquo;{c.reason}&rdquo;
                  </div>
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal
        open={!!correctionTarget}
        onClose={() => setCorrectionTarget(null)}
        title={`Request Correction — ${correctionTarget?.name || ""}`}
        description="Sent to your HOD for approval. The attendance record only changes once approved."
        footer={
          <>
            <Button variant="outline" onClick={() => setCorrectionTarget(null)}>Cancel</Button>
            <Button onClick={submitCorrection} disabled={correctionSubmitting || !correctionForm.reason.trim()}>
              {correctionSubmitting ? "Submitting..." : "Submit Request"}
            </Button>
          </>
        }
      >
        {correctionError && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{correctionError}</div>
        )}
        <div className="space-y-md">
          <FormField
            label="Requested Status"
            id="requested-status"
            type="select"
            value={correctionForm.requestedStatus}
            onChange={(v) => setCorrectionForm({ ...correctionForm, requestedStatus: v })}
            options={CORRECTABLE_STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
            required
          />
          <FormField
            label="Reason"
            id="correction-reason"
            type="textarea"
            value={correctionForm.reason}
            onChange={(v) => setCorrectionForm({ ...correctionForm, reason: v })}
            placeholder="Why does this record need correcting?"
            required
            rows={3}
          />
          <FormField
            label="Supporting evidence (optional)"
            id="correction-evidence"
            type="text"
            value={correctionForm.evidenceNote}
            onChange={(v) => setCorrectionForm({ ...correctionForm, evidenceNote: v })}
            placeholder="e.g. medical certificate reference, OD approval no."
          />
        </div>
      </Modal>
    </div>
  );
}
