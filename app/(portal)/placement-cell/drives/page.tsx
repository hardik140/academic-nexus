"use client";

import { useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import {
  listDrives,
  listCompaniesForSelect,
  listDepartmentsForSelect,
  createDrive,
  updateDrive,
  setDriveStatus,
  listApplicants,
  updateApplicationStatus,
  type DriveParams,
} from "./actions";

const DRIVES_PAGE_SIZE = 10;

const emptyForm: DriveParams = {
  companyId: "",
  jobRole: "",
  jobDescription: "",
  packageLpa: null,
  minCgpa: null,
  maxBacklogs: null,
  eligibleBatchYears: [],
  eligibleDepartmentIds: [],
  applicationDeadline: "",
  driveDate: "",
};

export default function PlacementCellDrives() {
  const [view, setView] = useState<"list" | "applicants">("list");
  const [drives, setDrives] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<unknown>(null);
  const [totalDrives, setTotalDrives] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DriveParams>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const latestLoad = useRef(0);

  const [selectedDrive, setSelectedDrive] = useState<any>(null);
  const [applicants, setApplicants] = useState<any[]>([]);
  const [applicantsLoading, setApplicantsLoading] = useState(false);
  const [applicantsError, setApplicantsError] = useState<unknown>(null);
  const latestApplicants = useRef(0);

  // The choices for the drive form. A failed load must not look like "no
  // departments": with none selected a drive is open to every department.
  const options = useAsyncResource(async () => {
    const [companies, departments] = await Promise.all([listCompaniesForSelect(), listDepartmentsForSelect()]);
    return { companies: companies as any[], departments: departments as any[] };
  }, []);
  const companies = options.data?.companies ?? [];
  const departments = options.data?.departments ?? [];

  // The latest query's page; a failed load is an error in the table, never
  // "No placement drives yet." (owner decision D5).
  const loadDrives = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setLoadingList(true);
    setListError(null);
    try {
      const { data, count } = await listDrives(q);
      if (run !== latestLoad.current) return;
      setDrives(data);
      setTotalDrives(count);
    } catch (e) {
      if (run === latestLoad.current) setListError(e);
    } finally {
      if (run === latestLoad.current) setLoadingList(false);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setShowForm(true);
  };

  const openEdit = (drive: any) => {
    setEditingId(drive.id);
    setForm({
      companyId: drive.company_id,
      jobRole: drive.job_role,
      jobDescription: drive.job_description || "",
      packageLpa: drive.package_lpa,
      minCgpa: drive.min_cgpa,
      maxBacklogs: drive.max_backlogs,
      eligibleBatchYears: drive.eligible_batch_years || [],
      eligibleDepartmentIds: [],
      applicationDeadline: drive.application_deadline?.slice(0, 16) || "",
      driveDate: drive.drive_date || "",
    });
    setError(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (editingId) {
        await updateDrive(editingId, form);
      } else {
        await createDrive(form);
      }
      setShowForm(false);
      setNotice(editingId ? `Drive for ${form.jobRole} saved.` : `Drive for ${form.jobRole} created.`);
      void loadDrives(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to save placement drive."));
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePublish = async (drive: any) => {
    if (busy) return;
    setBusy(drive.id);
    setError(null);
    setNotice(null);
    try {
      const next = drive.status === "published" ? "closed" : "published";
      await setDriveStatus(drive.id, next);
      setNotice(`Drive for ${drive.job_role} ${next === "published" ? "published" : "unpublished"}.`);
      void loadDrives(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update drive status."));
    } finally {
      setBusy(null);
    }
  };

  // A drive's applicants; a failed load is an error, never "No applicants yet."
  const loadApplicants = async (driveId: string) => {
    const run = ++latestApplicants.current;
    setApplicantsLoading(true);
    setApplicantsError(null);
    try {
      const data = await listApplicants(driveId);
      if (run === latestApplicants.current) setApplicants(data);
    } catch (e) {
      if (run === latestApplicants.current) setApplicantsError(e);
    } finally {
      if (run === latestApplicants.current) setApplicantsLoading(false);
    }
  };

  const openApplicants = async (drive: any) => {
    setSelectedDrive(drive);
    setView("applicants");
    setApplicants([]);
    setError(null);
    setNotice(null);
    await loadApplicants(drive.id);
  };

  const handleApplicantStatus = async (applicationId: string, status: "shortlisted" | "interview" | "selected" | "rejected") => {
    if (busy) return;
    setBusy(applicationId);
    setError(null);
    setNotice(null);
    try {
      await updateApplicationStatus(applicationId, status);
      setNotice(`Applicant ${status === "interview" ? "moved to interview" : status}.`);
      if (selectedDrive) void loadApplicants(selectedDrive.id);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update applicant status."));
    } finally {
      setBusy(null);
    }
  };

  const toggleDepartment = (id: string) => {
    const current = form.eligibleDepartmentIds || [];
    setForm({
      ...form,
      eligibleDepartmentIds: current.includes(id) ? current.filter((d) => d !== id) : [...current, id],
    });
  };

  const companyOptions = companies.map((c: any) => ({ value: c.id, label: c.name }));

  if (view === "applicants" && selectedDrive) {
    return (
      <div className="space-y-lg">
        <div className="flex items-center justify-between">
          <div>
            <button type="button" onClick={() => setView("list")} className="text-xs text-secondary hover:underline font-medium mb-xs">
              ← Back to Drives
            </button>
            <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
              Applicants — {selectedDrive.job_role}
            </h1>
            <p className="text-sm text-on-surface-variant mt-xs">{selectedDrive.companies?.name}</p>
          </div>
        </div>

        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
        <ErrorAlert error={error} />

        <DataTable
          title="Applicants"
          columns={[
            { key: "student", header: "Student", render: (row: any) => (row.students as any)?.profiles?.full_name || "—" },
            { key: "department", header: "Department", render: (row: any) => (row.students as any)?.departments?.name || "—" },
            { key: "cgpa", header: "CGPA", render: (row: any) => (row.students as any)?.cgpa ?? "—" },
            { key: "applied_at", header: "Applied", render: (row: any) => new Date(row.applied_at).toLocaleDateString() },
            { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
          ]}
          data={applicants}
          keyExtractor={(row) => row.id}
          emptyMessage="No applicants yet."
          loading={applicantsLoading}
          error={applicantsError}
          onRetry={() => loadApplicants(selectedDrive.id)}
          actions={(row: any) => (
            <div className="flex gap-sm justify-end">
              {row.status !== "shortlisted" && row.status !== "selected" && (
                <button type="button" disabled={busy !== null} aria-busy={busy === row.id || undefined} onClick={() => handleApplicantStatus(row.id, "shortlisted")} className="text-xs text-secondary hover:underline font-medium disabled:opacity-50">
                  Shortlist
                </button>
              )}
              {row.status === "shortlisted" && (
                <button type="button" disabled={busy !== null} aria-busy={busy === row.id || undefined} onClick={() => handleApplicantStatus(row.id, "interview")} className="text-xs text-info hover:underline font-medium disabled:opacity-50">
                  Interview
                </button>
              )}
              {row.status !== "selected" && row.status !== "rejected" && (
                <button type="button" disabled={busy !== null} aria-busy={busy === row.id || undefined} onClick={() => handleApplicantStatus(row.id, "selected")} className="text-xs text-success hover:underline font-medium disabled:opacity-50">
                  Select
                </button>
              )}
              {row.status !== "rejected" && row.status !== "selected" && (
                <button type="button" disabled={busy !== null} aria-busy={busy === row.id || undefined} onClick={() => handleApplicantStatus(row.id, "rejected")} className="text-xs text-error hover:underline font-medium disabled:opacity-50">
                  Reject
                </button>
              )}
            </div>
          )}
        />
      </div>
    );
  }

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placement Drives</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Create and run company hiring drives</p>
        </div>
        <Button onClick={openCreate}>+ Create Drive</Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The drive dialog shows its own failure. */}
      <ErrorAlert error={!showForm ? error : null} />

      <DataTable
        title="All Drives"
        columns={[
          { key: "company", header: "Company", render: (row: any) => row.companies?.name || "—" },
          { key: "job_role", header: "Role", sortable: true },
          { key: "package_lpa", header: "Package", sortable: true, render: (row: any) => (row.package_lpa ? `₹${row.package_lpa}L` : "—") },
          { key: "applications", header: "Applications", render: (row: any) => row.placement_applications?.[0]?.count ?? 0 },
          { key: "application_deadline", header: "Deadline", sortable: true, render: (row: any) => new Date(row.application_deadline).toLocaleDateString() },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={drives}
        keyExtractor={(row) => row.id}
        searchKey="job_role"
        searchPlaceholder="Search by role..."
        emptyMessage="No placement drives yet."
        onRowClick={openApplicants}
        serverMode
        totalCount={totalDrives}
        loading={loadingList}
        error={listError}
        onRetry={() => loadDrives(query)}
        onQueryChange={(q) => { setQuery(q); loadDrives(q); }}
        pageSize={DRIVES_PAGE_SIZE}
        actions={(row: any) => (
          <div className="flex gap-sm justify-end">
            <button type="button" onClick={(e) => { e.stopPropagation(); openEdit(row); }} className="text-xs text-secondary hover:underline font-medium">
              Edit
            </button>
            <button type="button" disabled={busy !== null} aria-busy={busy === row.id || undefined} onClick={(e) => { e.stopPropagation(); handleTogglePublish(row); }} className="text-xs text-on-surface-variant hover:underline font-medium disabled:opacity-50">
              {row.status === "published" ? "Unpublish" : "Publish"}
            </button>
          </div>
        )}
      />

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editingId ? "Edit Placement Drive" : "Create Placement Drive"}
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={loading || options.status !== "success" || !form.companyId || !form.jobRole || !form.applicationDeadline}
              aria-busy={loading || undefined}
            >
              {loading ? "Saving..." : editingId ? "Save Changes" : "Create Drive"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <Alert
          tone="error"
          className="mb-md"
          action={<Button variant="outline" size="sm" onClick={options.reload}>Try again</Button>}
        >
          {options.status === "error" ? (
            <>
              Companies and departments couldn&apos;t be loaded, so the drive can&apos;t be saved yet.
            </>
          ) : null}
        </Alert>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
          <FormField label="Company" id="company" type="select" value={form.companyId} onChange={(v) => setForm({ ...form, companyId: v })} options={companyOptions} required />
          <FormField label="Job Role" id="job_role" value={form.jobRole} onChange={(v) => setForm({ ...form, jobRole: v })} placeholder="e.g. Software Engineer" required />
          <FormField label="Package (LPA)" id="package_lpa" type="number" value={form.packageLpa ?? ""} onChange={(v) => setForm({ ...form, packageLpa: v ? Number(v) : null })} placeholder="7.00" />
          <FormField label="Minimum CGPA" id="min_cgpa" type="number" value={form.minCgpa ?? ""} onChange={(v) => setForm({ ...form, minCgpa: v ? Number(v) : null })} placeholder="7.0" />
          <FormField label="Max Backlogs Allowed" id="max_backlogs" type="number" value={form.maxBacklogs ?? ""} onChange={(v) => setForm({ ...form, maxBacklogs: v ? Number(v) : null })} placeholder="0" />
          <FormField label="Application Deadline" id="deadline" type="datetime-local" value={form.applicationDeadline} onChange={(v) => setForm({ ...form, applicationDeadline: v })} required />
          <FormField label="Drive Date" id="drive_date" type="date" value={form.driveDate || ""} onChange={(v) => setForm({ ...form, driveDate: v })} />
          <div className="md:col-span-2">
            <FormField label="Job Description" id="job_description" type="textarea" value={form.jobDescription || ""} onChange={(v) => setForm({ ...form, jobDescription: v })} rows={3} />
          </div>
          <div className="md:col-span-2">
            <span className="block text-sm font-medium text-on-surface-variant mb-xs">Eligible Departments</span>
            <div className="flex flex-wrap gap-sm">
              {departments.map((d: any) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDepartment(d.id)}
                  className={`text-xs font-semibold px-sm py-xs rounded-full border transition-colors ${
                    (form.eligibleDepartmentIds || []).includes(d.id)
                      ? "bg-secondary text-on-secondary border-secondary"
                      : "border-outline-variant text-on-surface-variant"
                  }`}
                >
                  {d.code}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-outline mt-xs">Leave none selected to allow all departments.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
