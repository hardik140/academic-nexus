"use client";

import { useState, useEffect } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { actOnLeaveRequest, listHodApprovals } from "./actions";

export default function HodApprovals() {
  const [pending, setPending] = useState<any[]>([]);
  const [processed, setProcessed] = useState<any[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadRequests(); }, []);

  const loadRequests = async () => {
    const { pending, processed } = await listHodApprovals();
    setPending(pending);
    setProcessed(processed);
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

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Staff Approvals</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Leave requests from staff in your department</p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Pending Queue */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔔 Pending Requests ({pending.length})</h2>
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

      {/* Processed */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Processed History ({processed.length})</h2>
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
    </div>
  );
}
