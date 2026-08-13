"use client";

import { useState, useEffect } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/modal";
import { updateComplaintStatus, listHostelComplaints } from "./actions";

const COMPLAINTS_PAGE_SIZE = 10;

export default function WardenComplaints() {
  const [complaints, setComplaints] = useState<any[]>([]);
  const [complaintsLoading, setComplaintsLoading] = useState(false);
  const [totalComplaints, setTotalComplaints] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadComplaints(query); }, [query]);

  const loadComplaints = async (q: DataTableQuery) => {
    setComplaintsLoading(true);
    const { data, count } = await listHostelComplaints(q);
    setComplaints(data);
    setTotalComplaints(count);
    setComplaintsLoading(false);
  };

  const updateStatus = async (id: string, status: "in_progress" | "resolved") => {
    setLoading(id);
    setError(null);
    try {
      await updateComplaintStatus(id, status, query);
      await loadComplaints(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update complaint.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Complaints</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Maintenance and hostel-related complaints</p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
        searchPlaceholder="Filter by title or student..."
        emptyMessage="No hostel complaints found."
        serverMode
        totalCount={totalComplaints}
        loading={complaintsLoading}
        onQueryChange={setQuery}
        pageSize={COMPLAINTS_PAGE_SIZE}
        actions={(row: any) => (
          <div className="flex gap-xs justify-end">
            {row.status === "open" && (
              <button onClick={() => updateStatus(row.id, "in_progress")} disabled={loading === row.id} className="text-xs text-secondary hover:underline font-medium disabled:opacity-40">
                {loading === row.id ? "..." : "Start"}
              </button>
            )}
            {row.status === "in_progress" && (
              <button onClick={() => updateStatus(row.id, "resolved")} disabled={loading === row.id} className="text-xs text-success hover:underline font-medium disabled:opacity-40">
                {loading === row.id ? "..." : "Resolve"}
              </button>
            )}
          </div>
        )}
      />
    </div>
  );
}
