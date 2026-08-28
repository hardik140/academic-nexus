"use client";

import { useState, useEffect } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { actOnLeaveRequest, listHodApprovals, actOnAttendanceCorrection, listCorrectionApprovals, previewLeaveImpact } from "./actions";

export default function HodApprovals() {
  const [pending, setPending] = useState<any[]>([]);
  const [processed, setProcessed] = useState<any[]>([]);
  const [pendingCorrections, setPendingCorrections] = useState<any[]>([]);
  const [processedCorrections, setProcessedCorrections] = useState<any[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Leave Impact Preview — keyed by request id; "loading" while the fetch is
  // in flight, otherwise the { teacherName, affectedClasses } result.
  const [impact, setImpact] = useState<Record<string, any>>({});

  const toggleImpact = async (requestId: string) => {
    if (impact[requestId]) {
      setImpact((prev) => { const next = { ...prev }; delete next[requestId]; return next; });
      return;
    }
    setImpact((prev) => ({ ...prev, [requestId]: "loading" }));
    try {
      const result = await previewLeaveImpact(requestId);
      setImpact((prev) => ({ ...prev, [requestId]: result }));
    } catch (e) {
      setImpact((prev) => ({ ...prev, [requestId]: { error: e instanceof Error ? e.message : "Failed to load impact." } }));
    }
  };

  useEffect(() => { loadRequests(); }, []);

  const loadRequests = async () => {
    const [{ pending, processed }, { pending: pendingCorr, processed: processedCorr }] = await Promise.all([
      listHodApprovals(),
      listCorrectionApprovals(),
    ]);
    setPending(pending);
    setProcessed(processed);
    setPendingCorrections(pendingCorr);
    setProcessedCorrections(processedCorr);
  };

  const handleAction = async (id: string, action: "approved" | "rejected") => {
    setLoading(id);
    setError(null);
    try {
      await actOnLeaveRequest(id, action);
      await loadRequests();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update request.");
    } finally {
      setLoading(null);
    }
  };

  const handleCorrectionAction = async (id: string, action: "approved" | "rejected") => {
    setLoading(id);
    setError(null);
    try {
      await actOnAttendanceCorrection(id, action);
      await loadRequests();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update correction request.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Staff Approvals</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Leave and attendance correction requests from staff in your department</p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Leave — Pending Queue */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔔 Pending Leave Requests ({pending.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {pending.length > 0 ? pending.map((req: any) => (
            <div key={req.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start justify-between gap-md">
                <div>
                  <div className="flex items-center gap-sm mb-xs">
                    <div className="w-8 h-8 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-xs font-bold">
                      {(req.profiles as any)?.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-on-surface">{(req.profiles as any)?.full_name}</div>
                      <div className="text-xs text-outline">{(req.profiles as any)?.role} • {(req.profiles as any)?.email}</div>
                    </div>
                  </div>
                  <div className="ml-10 space-y-xs">
                    <div className="text-xs">
                      <span className="font-semibold text-on-surface capitalize">{req.leave_type.replace(/_/g, " ")} Leave</span>
                      <span className="text-outline mx-sm">•</span>
                      <span className="text-outline">{new Date(req.start_date).toLocaleDateString()} → {new Date(req.end_date).toLocaleDateString()}</span>
                    </div>
                    <div className="text-sm text-on-surface-variant italic">&ldquo;{req.reason}&rdquo;</div>
                    <button
                      className="text-[11px] font-semibold text-secondary hover:underline"
                      onClick={() => toggleImpact(req.id)}
                    >
                      {impact[req.id] ? "Hide impact" : "Preview impact"}
                    </button>
                    {impact[req.id] === "loading" && (
                      <div className="text-xs text-outline">Loading affected classes...</div>
                    )}
                    {impact[req.id] && impact[req.id] !== "loading" && impact[req.id].error && (
                      <div className="text-xs text-error">{impact[req.id].error}</div>
                    )}
                    {impact[req.id] && impact[req.id] !== "loading" && !impact[req.id].error && (
                      <div className="bg-surface-container-low border border-outline-variant rounded-lg p-sm text-xs">
                        <div className="font-semibold text-on-surface mb-xs">
                          Affected Classes: {impact[req.id].affectedClasses.length}
                        </div>
                        {impact[req.id].affectedClasses.length > 0 ? (
                          <ul className="space-y-xs text-outline">
                            {impact[req.id].affectedClasses.map((c: any, idx: number) => (
                              <li key={idx}>
                                {new Date(c.date).toLocaleDateString()} · {c.courseCode} {c.courseName} ({c.startTime?.slice(0, 5)}–{c.endTime?.slice(0, 5)})
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="text-outline">No scheduled classes fall within this date range.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-xs shrink-0">
                  <Button size="sm" variant="destructive" onClick={() => handleAction(req.id, "rejected")} disabled={loading === req.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleAction(req.id, "approved")} disabled={loading === req.id}>
                    {loading === req.id ? "..." : "Approve"}
                  </Button>
                </div>
              </div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No pending requests.</div>
          )}
        </div>
      </div>

      {/* Leave — Processed */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Processed Leave History ({processed.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {processed.map((req: any) => (
            <div key={req.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-center gap-sm">
                <div className="w-7 h-7 rounded-full bg-surface-container-high text-on-surface-variant flex items-center justify-center text-[10px] font-bold">
                  {(req.profiles as any)?.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                </div>
                <div>
                  <div className="text-sm text-on-surface">{(req.profiles as any)?.full_name} — <span className="capitalize">{req.leave_type.replace(/_/g, " ")}</span></div>
                  <div className="text-xs text-outline">{new Date(req.start_date).toLocaleDateString()} → {new Date(req.end_date).toLocaleDateString()}</div>
                </div>
              </div>
              <StatusBadge status={req.status} />
            </div>
          ))}
          {processed.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No processed requests yet.</div>
          )}
        </div>
      </div>

      {/* Attendance Corrections — Pending Queue */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">✏️ Pending Attendance Corrections ({pendingCorrections.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {pendingCorrections.length > 0 ? pendingCorrections.map((req: any) => (
            <div key={req.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start justify-between gap-md">
                <div>
                  <div className="text-sm font-semibold text-on-surface">
                    {(req.profiles as any)?.full_name} — {(req.courses as any)?.code} — {(req.students as any)?.enrollment_number}
                  </div>
                  <div className="text-xs text-outline mt-xs">
                    {new Date(req.date).toLocaleDateString()} · <span className="capitalize">{req.current_status}</span> → <span className="capitalize font-semibold text-on-surface">{req.requested_status}</span>
                  </div>
                  <div className="text-sm text-on-surface-variant italic mt-xs">&ldquo;{req.reason}&rdquo;</div>
                  {req.evidence_note && (
                    <div className="text-xs text-outline mt-xs">Evidence: {req.evidence_note}</div>
                  )}
                </div>
                <div className="flex gap-xs shrink-0">
                  <Button size="sm" variant="destructive" onClick={() => handleCorrectionAction(req.id, "rejected")} disabled={loading === req.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleCorrectionAction(req.id, "approved")} disabled={loading === req.id}>
                    {loading === req.id ? "..." : "Approve"}
                  </Button>
                </div>
              </div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No pending correction requests.</div>
          )}
        </div>
      </div>

      {/* Attendance Corrections — Processed */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Processed Corrections ({processedCorrections.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {processedCorrections.map((req: any) => (
            <div key={req.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm text-on-surface">
                  {(req.profiles as any)?.full_name} — {(req.courses as any)?.code} — <span className="capitalize">{req.current_status} → {req.requested_status}</span>
                </div>
                <div className="text-xs text-outline">{new Date(req.date).toLocaleDateString()}</div>
              </div>
              <StatusBadge status={req.status} />
            </div>
          ))}
          {processedCorrections.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No processed correction requests yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
