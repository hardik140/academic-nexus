"use client";

import { useEffect, useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { updateComplaintStatus, listHostelComplaints } from "./actions";

const COMPLAINTS_PAGE_SIZE = 10;

export default function WardenComplaints() {
  const [complaints, setComplaints] = useState<any[]>([]);
  const [complaintsLoading, setComplaintsLoading] = useState(false);
  const [complaintsError, setComplaintsError] = useState<unknown>(null);
  const [totalComplaints, setTotalComplaints] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestLoad = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadComplaints(query); }, [query]);

  // The latest query's page; a failed load is an error in the table, never
  // "No hostel complaints found." (owner decision D5).
  const loadComplaints = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setComplaintsLoading(true);
    setComplaintsError(null);
    try {
      const { data, count } = await listHostelComplaints(q);
      if (run !== latestLoad.current) return;
      setComplaints(data);
      setTotalComplaints(count);
    } catch (e) {
      if (run === latestLoad.current) setComplaintsError(e);
    } finally {
      if (run === latestLoad.current) setComplaintsLoading(false);
    }
  };

  const updateStatus = async (id: string, status: "in_progress" | "resolved") => {
    if (loading) return;
    setLoading(id);
    setError(null);
    setNotice(null);
    try {
      await updateComplaintStatus(id, status, query);
      setNotice(status === "resolved" ? "Complaint marked resolved." : "Complaint marked in progress.");
      void loadComplaints(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update complaint."));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Complaints</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Maintenance and hostel-related complaints</p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      <ErrorAlert error={error} />

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
                row.priority === "critical" ? "bg-error-container text-on-error-container" :
                row.priority === "high" ? "bg-warning-container text-on-warning-container" : "bg-info-container text-on-info-container"
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
        error={complaintsError}
        onRetry={() => loadComplaints(query)}
        onQueryChange={setQuery}
        pageSize={COMPLAINTS_PAGE_SIZE}
        actions={(row: any) => (
          <div className="flex gap-xs justify-end">
            {row.status === "open" && (
              <button type="button" onClick={() => updateStatus(row.id, "in_progress")} disabled={loading === row.id} aria-busy={loading === row.id || undefined} className="text-xs text-secondary hover:underline font-medium disabled:opacity-40">
                {loading === row.id ? "..." : "Start"}
              </button>
            )}
            {row.status === "in_progress" && (
              <button type="button" onClick={() => updateStatus(row.id, "resolved")} disabled={loading === row.id} aria-busy={loading === row.id || undefined} className="text-xs text-success hover:underline font-medium disabled:opacity-40">
                {loading === row.id ? "..." : "Resolve"}
              </button>
            )}
          </div>
        )}
      />
    </div>
  );
}
