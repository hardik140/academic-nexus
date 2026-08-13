"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { createPlacement, listPlacements } from "./actions";
import type { Database } from "@/types/database";

type OfferType = NonNullable<Database["public"]["Tables"]["placements"]["Row"]["offer_type"]>;
type PlacementStatus = Database["public"]["Tables"]["placements"]["Row"]["status"];

const OFFER_TYPES: { value: OfferType; label: string }[] = [
  { value: "full_time", label: "Full-time" },
  { value: "internship", label: "Internship" },
  { value: "ppo", label: "PPO" },
];

const STATUSES: { value: PlacementStatus; label: string }[] = [
  { value: "placed", label: "Placed" },
  { value: "joined", label: "Joined" },
  { value: "declined", label: "Declined" },
  { value: "offer_revoked", label: "Offer Revoked" },
];

const PLACEMENTS_PAGE_SIZE = 10;

export default function DirectorPlacements() {
  const supabase = createClient();
  const [summary, setSummary] = useState<any>(null);
  const [placements, setPlacements] = useState<any[]>([]);
  const [placementsLoading, setPlacementsLoading] = useState(false);
  const [totalPlacements, setTotalPlacements] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [students, setStudents] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{
    student_id: string;
    company_name: string;
    role_title: string;
    package_lpa: string;
    placement_date: string;
    offer_type: OfferType;
    status: PlacementStatus;
  }>({
    student_id: "",
    company_name: "",
    role_title: "",
    package_lpa: "",
    placement_date: "",
    offer_type: "full_time",
    status: "placed",
  });

  useEffect(() => { loadSummary(); loadStudents(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadPlacements(query); }, [query]);

  const loadSummary = async () => {
    const { data } = await supabase.from("mv_placement_summary").select("*").maybeSingle();
    setSummary(data);
  };

  const loadPlacements = async (q: DataTableQuery) => {
    setPlacementsLoading(true);
    const { data, count } = await listPlacements(q);
    setPlacements(data);
    setTotalPlacements(count);
    setPlacementsLoading(false);
  };

  const loadStudents = async () => {
    const { data } = await supabase
      .from("students")
      .select("id, enrollment_number, profiles:user_id(full_name)")
      .order("enrollment_number");
    setStudents(data || []);
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createPlacement(
        form.student_id,
        form.company_name,
        form.role_title,
        form.package_lpa ? Number(form.package_lpa) : null,
        form.placement_date,
        form.offer_type,
        form.status,
        query
      );
      setForm({ student_id: "", company_name: "", role_title: "", package_lpa: "", placement_date: "", offer_type: "full_time", status: "placed" });
      setShowCreate(false);
      await Promise.all([loadSummary(), loadPlacements(query)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add placement record.");
    } finally {
      setLoading(false);
    }
  };

  const studentOptions = students.map((s: any) => ({
    value: s.id,
    label: `${s.enrollment_number} — ${(s.profiles as any)?.full_name || ""}`,
  }));

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placements</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Institution-wide placement outcomes</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Placement Record</Button>
      </div>

      {error && !showCreate && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Students Placed</div>
          <div className="text-2xl font-extrabold text-secondary">{summary?.total_placed || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Companies</div>
          <div className="text-2xl font-extrabold text-on-surface">{summary?.total_companies || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Avg Package</div>
          <div className="text-2xl font-extrabold text-success">₹{summary?.avg_package || 0}L</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Max Package</div>
          <div className="text-2xl font-extrabold text-success">₹{summary?.max_package || 0}L</div>
        </div>
      </div>

      <DataTable
        title="Placement Records"
        columns={[
          { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students as any)?.profiles?.full_name || "—"}</span> },
          { key: "department", header: "Department", render: (row: any) => (row.students as any)?.departments?.name || "—" },
          { key: "company_name", header: "Company", sortable: true },
          { key: "role_title", header: "Role", render: (row: any) => <span className="text-on-surface-variant">{row.role_title}</span> },
          { key: "package_lpa", header: "Package", sortable: true, render: (row: any) => row.package_lpa ? <span className="text-success font-semibold">₹{row.package_lpa}L</span> : "—" },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={placements}
        keyExtractor={(row) => row.id}
        searchKey="company_name"
        searchPlaceholder="Search by company..."
        emptyMessage="No placement records yet."
        serverMode
        totalCount={totalPlacements}
        loading={placementsLoading}
        onQueryChange={setQuery}
        pageSize={PLACEMENTS_PAGE_SIZE}
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Placement Record"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading || !form.student_id || !form.company_name || !form.role_title}>{loading ? "Saving..." : "Add Record"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Student" id="student" type="select" value={form.student_id} onChange={(v) => setForm({ ...form, student_id: v })} options={studentOptions} required />
          <FormField label="Company" id="company_name" value={form.company_name} onChange={(v) => setForm({ ...form, company_name: v })} placeholder="e.g. Acme Corp" required />
          <FormField label="Role" id="role_title" value={form.role_title} onChange={(v) => setForm({ ...form, role_title: v })} placeholder="e.g. Software Engineer" required />
          <FormField label="Package (LPA)" id="package_lpa" type="number" value={form.package_lpa} onChange={(v) => setForm({ ...form, package_lpa: v })} placeholder="0.00" />
          <FormField label="Placement Date" id="placement_date" type="date" value={form.placement_date} onChange={(v) => setForm({ ...form, placement_date: v })} required />
          <FormField label="Offer Type" id="offer_type" type="select" value={form.offer_type} onChange={(v) => setForm({ ...form, offer_type: v as OfferType })} options={OFFER_TYPES} />
          <FormField label="Status" id="status" type="select" value={form.status} onChange={(v) => setForm({ ...form, status: v as PlacementStatus })} options={STATUSES} />
        </div>
      </Modal>
    </div>
  );
}
