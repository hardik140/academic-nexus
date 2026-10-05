"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import { formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import { createScholarship, listScholarships } from "./actions";
import type { Database } from "@/types/database";

type ScholarshipType = Database["public"]["Tables"]["scholarships"]["Row"]["type"];

const SCHOLARSHIP_TYPES: { value: ScholarshipType; label: string }[] = [
  { value: "merit", label: "Merit" },
  { value: "need", label: "Need-based" },
  { value: "sports", label: "Sports" },
  { value: "government", label: "Government" },
  { value: "corporate", label: "Corporate" },
  { value: "other", label: "Other" },
];

const SCHOLARSHIPS_PAGE_SIZE = 10;

export default function FinanceScholarships() {
  const supabase = createClient();
  const [scholarships, setScholarships] = useState<any[]>([]);
  const [scholarshipsLoading, setScholarshipsLoading] = useState(false);
  const [scholarshipsError, setScholarshipsError] = useState<unknown>(null);
  const [totalScholarships, setTotalScholarships] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestLoad = useRef(0);
  const [form, setForm] = useState<{ student_id: string; name: string; amount: string; type: ScholarshipType; academic_year: string }>({
    student_id: "",
    name: "",
    amount: "",
    type: "merit",
    academic_year: "",
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadScholarships(query); }, [query]);

  // The latest query's page; a failed load is an error in the table, never
  // "No scholarships awarded yet." (owner decision D5).
  const loadScholarships = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setScholarshipsLoading(true);
    setScholarshipsError(null);
    try {
      const { data, count } = await listScholarships(q);
      if (run !== latestLoad.current) return;
      setScholarships(data);
      setTotalScholarships(count);
    } catch (e) {
      if (run === latestLoad.current) setScholarshipsError(e);
    } finally {
      if (run === latestLoad.current) setScholarshipsLoading(false);
    }
  };

  const studentsResource = useAsyncResource(
    async () =>
      requireRows(
        await supabase
          .from("students")
          .select("id, enrollment_number, profiles:user_id(full_name)")
          .order("enrollment_number")
      ),
    []
  );
  const students: any[] = studentsResource.data ?? [];

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createScholarship(form.student_id, form.name, form.type, Number(form.amount), form.academic_year || undefined);
      setForm({ student_id: "", name: "", amount: "", type: "merit", academic_year: "" });
      setShowCreate(false);
      setNotice(`Scholarship ${form.name} awarded.`);
      void loadScholarships(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to award scholarship."));
    } finally {
      setLoading(false);
    }
  };

  const studentOptions = students.map((s) => ({
    value: s.id,
    label: `${s.enrollment_number} — ${(s.profiles as any)?.full_name || ""}`,
  }));

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Scholarships</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage student scholarships and awards</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Award Scholarship</Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>

      {/* The award dialog shows its own failure. */}
      <ErrorAlert error={!showCreate ? error : null} />

      <DataTable
        columns={[
          { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students as any)?.profiles?.full_name || "—"}</span> },
          { key: "name", header: "Scholarship", sortable: true },
          { key: "type", header: "Type", render: (row: any) => <span className="capitalize">{row.type}</span> },
          { key: "amount", header: "Amount", sortable: true, render: (row: any) => formatMoney(row.amount) },
          { key: "awarded_date", header: "Awarded", render: (row: any) => row.awarded_date ? formatDate(row.awarded_date) : "—" },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={scholarships}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search scholarships..."
        emptyMessage="No scholarships awarded yet."
        serverMode
        totalCount={totalScholarships}
        loading={scholarshipsLoading}
        error={scholarshipsError}
        onRetry={() => loadScholarships(query)}
        onQueryChange={setQuery}
        pageSize={SCHOLARSHIPS_PAGE_SIZE}
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Award Scholarship"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading || !form.student_id} aria-busy={loading || undefined}>{loading ? "Saving..." : "Award Scholarship"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <Alert
          tone="error"
          className="mb-md"
          action={<Button variant="outline" size="sm" onClick={studentsResource.reload}>Try again</Button>}
        >
          {studentsResource.status === "error" ? (
            <>
              Students couldn&apos;t be loaded, so none can be chosen yet.
            </>
          ) : null}
        </Alert>
        <div className="space-y-md">
          <FormField label="Student" id="student" type="select" value={form.student_id} onChange={(v) => setForm({ ...form, student_id: v })} options={studentOptions} required />
          <FormField label="Scholarship Name" id="name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Dean's Merit Award" required />
          <FormField label="Type" id="type" type="select" value={form.type} onChange={(v) => setForm({ ...form, type: v as ScholarshipType })} options={SCHOLARSHIP_TYPES} required />
          <FormField label="Amount" id="amount" type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} placeholder="0.00" required />
          <FormField label="Academic Year" id="academic_year" value={form.academic_year} onChange={(v) => setForm({ ...form, academic_year: v })} placeholder="e.g. 2025-26" />
        </div>
      </Modal>
    </div>
  );
}
