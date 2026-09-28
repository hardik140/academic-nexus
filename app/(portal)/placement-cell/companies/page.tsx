"use client";

import { useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { createCompany, updateCompany, listCompanies, type CompanyParams } from "./actions";

const COMPANIES_PAGE_SIZE = 10;

const emptyForm: CompanyParams = {
  name: "",
  industry: "",
  website: "",
  location: "",
  hrContactName: "",
  hrEmail: "",
  hrPhone: "",
  description: "",
  status: "active",
};

export default function PlacementCellCompanies() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [totalCompanies, setTotalCompanies] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CompanyParams>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCompanies = async (q: DataTableQuery) => {
    setLoadingList(true);
    const { data, count } = await listCompanies(q);
    setCompanies(data);
    setTotalCompanies(count);
    setLoadingList(false);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setShowForm(true);
  };

  const openEdit = (company: any) => {
    setEditingId(company.id);
    setForm({
      name: company.name,
      industry: company.industry || "",
      website: company.website || "",
      location: company.location || "",
      hrContactName: company.hr_contact_name || "",
      hrEmail: company.hr_email || "",
      hrPhone: company.hr_phone || "",
      description: company.description || "",
      status: company.status,
    });
    setError(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      if (editingId) {
        await updateCompany(editingId, form, query);
      } else {
        await createCompany(form, query);
      }
      setShowForm(false);
      await loadCompanies(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save company.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Companies</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Recruiters in your college&apos;s placement ecosystem</p>
        </div>
        <Button onClick={openCreate}>+ Add Company</Button>
      </div>

      {error && !showForm && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <DataTable
        title="All Companies"
        columns={[
          { key: "name", header: "Company", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "industry", header: "Industry", sortable: true, render: (row: any) => row.industry || "—" },
          { key: "location", header: "Location", render: (row: any) => row.location || "—" },
          { key: "hr_contact_name", header: "HR Contact", render: (row: any) => row.hr_contact_name || "—" },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={companies}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search companies..."
        emptyMessage="No companies added yet."
        onRowClick={openEdit}
        serverMode
        totalCount={totalCompanies}
        loading={loadingList}
        onQueryChange={(q) => { setQuery(q); loadCompanies(q); }}
        pageSize={COMPANIES_PAGE_SIZE}
      />

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editingId ? "Edit Company" : "Add Company"}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={loading || !form.name}>
              {loading ? "Saving..." : editingId ? "Save Changes" : "Add Company"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
          <FormField label="Company Name" id="name" value={form.name || ""} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. TCS" required />
          <FormField label="Industry" id="industry" value={form.industry || ""} onChange={(v) => setForm({ ...form, industry: v })} placeholder="e.g. IT Services" />
          <FormField label="Website" id="website" value={form.website || ""} onChange={(v) => setForm({ ...form, website: v })} placeholder="https://..." />
          <FormField label="Location" id="location" value={form.location || ""} onChange={(v) => setForm({ ...form, location: v })} placeholder="e.g. Bengaluru" />
          <FormField label="HR Contact Name" id="hr_contact" value={form.hrContactName || ""} onChange={(v) => setForm({ ...form, hrContactName: v })} />
          <FormField label="HR Email" id="hr_email" type="email" value={form.hrEmail || ""} onChange={(v) => setForm({ ...form, hrEmail: v })} />
          <FormField label="HR Phone" id="hr_phone" value={form.hrPhone || ""} onChange={(v) => setForm({ ...form, hrPhone: v })} />
          <FormField
            label="Status"
            id="status"
            type="select"
            value={form.status || "active"}
            onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
            options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]}
          />
          <div className="md:col-span-2">
            <FormField label="Description" id="description" type="textarea" value={form.description || ""} onChange={(v) => setForm({ ...form, description: v })} rows={3} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
