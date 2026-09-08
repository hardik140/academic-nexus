"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { actOnRiskFlag, listMyRiskFlagAssignments } from "@/app/(portal)/director/attention/actions";

/**
 * Shared by HOD, Warden, and Placement Cell dashboards — shows risk_flags
 * assigned to the current user (escalation_act RLS/permission restricts
 * this to the actual assignee) with Acknowledge/Start/Resolve actions.
 * Teacher deliberately does NOT get this panel (no faculty-scoped risk
 * flags are generated yet — Teacher gets a plain notification instead,
 * see teacher/dashboard/page.tsx).
 */
export function DirectorEscalationsPanel() {
  const [flags, setFlags] = useState<any[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await listMyRiskFlagAssignments();
      setFlags(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load escalations.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const act = async (flagId: string, action: "acknowledge" | "start" | "resolve") => {
    setLoading(flagId);
    setError(null);
    try {
      await actOnRiskFlag({ flagId, action, resolutionNotes: action === "resolve" ? resolutionNotes.trim() || undefined : undefined });
      setResolveTarget(null);
      setResolutionNotes("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update.");
    } finally {
      setLoading(null);
    }
  };

  if (flags.length === 0 && !error) return null;

  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
      <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
        <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🚨 Director Escalations ({flags.length})</h2>
      </div>
      {error && <div className="px-lg py-md bg-error/10 text-error text-sm font-medium">{error}</div>}
      <div className="divide-y divide-outline-variant">
        {flags.map((f: any) => (
          <div key={f.id} className="px-lg py-md">
            <div className="flex items-start justify-between gap-md">
              <Link href={`/director/attention/${f.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-sm mb-xs flex-wrap">
                  <StatusBadge status={f.severity} />
                  <StatusBadge status={f.status} />
                </div>
                <div className="text-sm font-semibold text-on-surface">{f.title}</div>
                <div className="text-xs text-outline mt-xs">{f.description}</div>
              </Link>
              <div className="flex gap-xs shrink-0">
                {f.status === "assigned" && (
                  <Button size="sm" variant="outline" onClick={() => act(f.id, "acknowledge")} disabled={loading === f.id}>
                    Acknowledge
                  </Button>
                )}
                {f.status === "acknowledged" && (
                  <Button size="sm" variant="outline" onClick={() => act(f.id, "start")} disabled={loading === f.id}>
                    Start
                  </Button>
                )}
                {(f.status === "acknowledged" || f.status === "in_progress") && (
                  <Button size="sm" onClick={() => setResolveTarget(f.id)} disabled={loading === f.id}>
                    Resolve
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={!!resolveTarget}
        onClose={() => setResolveTarget(null)}
        title="Resolve Escalation"
        footer={
          <>
            <Button variant="outline" onClick={() => setResolveTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => resolveTarget && act(resolveTarget, "resolve")} disabled={loading === resolveTarget}>
              {loading === resolveTarget ? "..." : "Mark Resolved"}
            </Button>
          </>
        }
      >
        <FormField
          label="Resolution notes"
          id="resolution-notes"
          type="textarea"
          rows={3}
          value={resolutionNotes}
          onChange={setResolutionNotes}
          placeholder="What was done to resolve this?"
        />
      </Modal>
    </div>
  );
}
