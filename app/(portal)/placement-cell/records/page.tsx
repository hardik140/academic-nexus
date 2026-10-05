"use client";

import { useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { listStudentPlacementRecords, updateStudentPlacementStatus } from "./actions";

const RECORDS_PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  { value: "not_placed", label: "Not Placed" },
  { value: "eligible", label: "Eligible" },
  { value: "applied", label: "Applied" },
  { value: "shortlisted", label: "Shortlisted" },
  { value: "selected", label: "Selected" },
  { value: "placed", label: "Placed" },
  { value: "rejected", label: "Rejected" },
  { value: "opted_out", label: "Opted Out" },
];

export default function PlacementCellRecords() {
  const [records, setRecords] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<unknown>(null);
  const [totalRecords, setTotalRecords] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [editing, setEditing] = useState<any>(null);
  const [status, setStatus] = useState("not_placed");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestLoad = useRef(0);

  // The latest query's page; a failed load is an error in the table, never
  // "No students found." (owner decision D5).
  const loadRecords = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setLoadingList(true);
    setListError(null);
    try {
      const { data, count } = await listStudentPlacementRecords(q);
      if (run !== latestLoad.current) return;
      setRecords(data);
      setTotalRecords(count);
    } catch (e) {
      if (run === latestLoad.current) setListError(e);
    } finally {
      if (run === latestLoad.current) setLoadingList(false);
    }
  };

  const openEdit = (row: any) => {
    setEditing(row);
    setStatus(row.student_placement_profiles?.placement_status || "not_placed");
    setNotes("");
    setError(null);
  };

  const handleSave = async () => {
    if (!editing || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await updateStudentPlacementStatus(editing.id, status as any, notes);
      setNotice(`Placement status updated for ${editing.profiles?.full_name || "the student"}.`);
      setEditing(null);
      void loadRecords(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update placement record."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Student Placement Records</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Master placement status for every student</p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The update dialog shows its own failure. */}
      <ErrorAlert error={!editing ? error : null} />

      <DataTable
        title="All Students"
        columns={[
          { key: "student", header: "Student", render: (row: any) => (row.profiles as any)?.full_name || "—" },
          { key: "enrollment_number", header: "Enrollment No.", sortable: true },
          { key: "department", header: "Department", render: (row: any) => (row.departments as any)?.name || "—" },
          { key: "batch_year", header: "Year", sortable: true },
          {
            key: "status",
            header: "Placement Status",
            render: (row: any) => <StatusBadge status={row.student_placement_profiles?.placement_status || "not_placed"} />,
          },
          { key: "company", header: "Company", render: (row: any) => row.placement?.company_name || "—" },
          { key: "package", header: "Package", render: (row: any) => (row.placement?.package_lpa ? `₹${row.placement.package_lpa}L` : "—") },
        ]}
        data={records}
        keyExtractor={(row) => row.id}
        searchKey="enrollment_number"
        searchPlaceholder="Search by enrollment no..."
        emptyMessage="No students found."
        onRowClick={openEdit}
        serverMode
        totalCount={totalRecords}
        loading={loadingList}
        error={listError}
        onRetry={() => loadRecords(query)}
        onQueryChange={(q) => { setQuery(q); loadRecords(q); }}
        pageSize={RECORDS_PAGE_SIZE}
      />

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Update Placement Status — ${(editing?.profiles as any)?.full_name || ""}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={loading} aria-busy={loading || undefined}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField label="Placement Status" id="status" type="select" value={status} onChange={setStatus} options={STATUS_OPTIONS} required />
          <FormField label="Notes (optional)" id="notes" type="textarea" value={notes} onChange={setNotes} rows={3} />
        </div>
      </Modal>
    </div>
  );
}
