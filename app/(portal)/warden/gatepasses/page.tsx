"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, StatusBadge } from "@/components/ui/modal";

export default function WardenGatePasses() {
  const supabase = createClient();
  const [passes, setPasses] = useState<any[]>([]);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => { loadPasses(); }, []);

  const loadPasses = async () => {
    const { data } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .order("created_at", { ascending: false });
    setPasses(data || []);
  };

  const handleAction = async (id: string, action: "approved" | "rejected") => {
    setLoading(id);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("gate_passes").update({
      status: action,
      approved_by: user?.id,
      approved_at: new Date().toISOString(),
    }).eq("id", id);
    setLoading(null);
    loadPasses();
  };

  const pending = passes.filter((p) => p.status === "pending");
  const processed = passes.filter((p) => p.status !== "pending");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Passes</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Review and approve student out-of-campus requests</p>
      </div>

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

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Processed ({processed.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {processed.slice(0, 20).map((pass: any) => (
            <div key={pass.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm text-on-surface">{(pass.students as any)?.profiles?.full_name} — {pass.destination}</div>
                <div className="text-xs text-outline">{new Date(pass.exit_time).toLocaleDateString()}</div>
              </div>
              <StatusBadge status={pass.status} />
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
