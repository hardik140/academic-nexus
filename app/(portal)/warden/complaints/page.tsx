"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/modal";

const HOSTEL_CATEGORIES = ["hostel", "mess", "plumbing", "electrical", "ac_hvac", "carpentry", "cleaning", "safety"];

export default function WardenComplaints() {
  const supabase = createClient();
  const [complaints, setComplaints] = useState<any[]>([]);

  useEffect(() => { loadComplaints(); }, []);

  const loadComplaints = async () => {
    const { data } = await supabase
      .from("complaints")
      .select("*, profiles:submitted_by(full_name)")
      .in("category", HOSTEL_CATEGORIES)
      .order("created_at", { ascending: false });
    setComplaints(data || []);
  };

  const updateStatus = async (id: string, status: string) => {
    await supabase.from("complaints").update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null }).eq("id", id);
    loadComplaints();
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Complaints</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Maintenance and hostel-related complaints</p>
      </div>

      <DataTable
        columns={[
          { key: "title", header: "Complaint", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.title}</span> },
          { key: "category", header: "Category", render: (row: any) => <span className="capitalize">{row.category.replace(/_/g, " ")}</span> },
          { key: "profiles", header: "Reported By", render: (row: any) => (row.profiles as any)?.full_name || "—" },
          {
            key: "priority",
            header: "Priority",
            render: (row: any) => (
              <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                row.priority === "critical" ? "bg-error/10 text-error" :
                row.priority === "high" ? "bg-warning/10 text-warning" : "bg-info/10 text-info"
              }`}>{row.priority}</span>
            ),
          },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={complaints}
        keyExtractor={(row) => row.id}
        searchKey="title"
        searchPlaceholder="Search complaints..."
        emptyMessage="No hostel complaints found."
        actions={(row: any) => (
          <div className="flex gap-xs justify-end">
            {row.status === "open" && (
              <button onClick={() => updateStatus(row.id, "in_progress")} className="text-xs text-secondary hover:underline font-medium">Start</button>
            )}
            {row.status === "in_progress" && (
              <button onClick={() => updateStatus(row.id, "resolved")} className="text-xs text-success hover:underline font-medium">Resolve</button>
            )}
          </div>
        )}
      />
    </div>
  );
}
