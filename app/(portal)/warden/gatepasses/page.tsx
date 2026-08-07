"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, StatusBadge } from "@/components/ui/modal";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_QUERY_LIMIT } from "@/lib/constants";
import { actOnGatePass } from "./actions";

export default function WardenGatePasses() {
  const supabase = createClient();
  const [passes, setPasses] = useState<any[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadPasses(); }, []);

  const loadPasses = async () => {
    const { data } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .order("created_at", { ascending: false })
      .limit(DEFAULT_QUERY_LIMIT);
    setPasses(data || []);
  };

  const handleAction = async (id: string, action: "approved" | "rejected") => {
    setLoading(id);
    setError(null);
    try {
      await actOnGatePass(id, action);
      await loadPasses();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update gate pass.");
    } finally {
      setLoading(null);
    }
  };

  const pending = passes.filter((p) => p.status === "pending");
  const processed = passes.filter((p) => p.status !== "pending");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Passes</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Review and approve student out-of-campus requests</p>
        </div>
        {pending.length > 0 && (
          <span className="text-xs font-semibold px-md py-xs rounded-full bg-warning/10 text-warning shrink-0">
            {pending.length} Require Action
          </span>
        )}
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Pending Requests ({pending.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {pending.length > 0 ? pending.map((pass: any) => (
            <div key={pass.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start justify-between gap-md">
                <div>
                  <div className="text-sm font-semibold text-on-surface">{(pass.students as any)?.profiles?.full_name}</div>
                  <div className="text-xs text-outline">{(pass.students as any)?.enrollment_number}</div>
                  <div className="text-xs text-on-surface-variant mt-xs">
                    {pass.destination} — {pass.reason}
                  </div>
                  <div className="text-xs text-outline mt-xs">
                    {new Date(pass.exit_time).toLocaleString()} → {new Date(pass.return_time).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-xs shrink-0">
                  <Button size="sm" variant="destructive" onClick={() => handleAction(pass.id, "rejected")} disabled={loading === pass.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleAction(pass.id, "approved")} disabled={loading === pass.id}>
                    {loading === pass.id ? "..." : "Approve"}
                  </Button>
                </div>
              </div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No pending gate passes.</div>
          )}
        </div>
      </div>

      <DataTable
        title={`Processed History (${processed.length})`}
        columns={[
          { key: "student", header: "Student", render: (row: any) => (row.students as any)?.profiles?.full_name || "—" },
          { key: "exit_time", header: "Date", sortable: true, render: (row: any) => new Date(row.exit_time).toLocaleDateString() },
          { key: "destination", header: "Destination", sortable: true },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={processed}
        keyExtractor={(row) => row.id}
        emptyMessage="No processed requests yet."
      />
    </div>
  );
}
