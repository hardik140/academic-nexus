"use client";

import { useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
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
  const [totalRecords, setTotalRecords] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [editing, setEditing] = useState<any>(null);
  const [status, setStatus] = useState("not_placed");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRecords = async (q: DataTableQuery) => {
    setLoadingList(true);
    const { data, count } = await listStudentPlacementRecords(q);
    setRecords(data);
    setTotalRecords(count);
    setLoadingList(false);
  };

  const openEdit = (row: any) => {
    setEditing(row);
    setStatus(row.student_placement_profiles?.placement_status || "not_placed");
    setNotes("");
    setError(null);
  };

  const handleSave = async () => {
    if (!editing) return;
    setLoading(true);
    setError(null);
    try {
      await updateStudentPlacementStatus(editing.id, status as any, notes, query);
      setEditing(null);
      await loadRecords(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update placement record.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Student Placement Records</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Master placement status for every student</p>
      </div>

      {error && !editing && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
            <Button onClick={handleSave} disabled={loading}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Placement Status" id="status" type="select" value={status} onChange={setStatus} options={STATUS_OPTIONS} required />
          <FormField label="Notes (optional)" id="notes" type="textarea" value={notes} onChange={setNotes} rows={3} />
        </div>
      </Modal>
    </div>
  );
}
