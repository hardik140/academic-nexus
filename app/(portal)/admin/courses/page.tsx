"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import { createCourse, listCourses } from "./actions";
import type { Database } from "@/types/database";

type CourseType = Database["public"]["Tables"]["courses"]["Row"]["type"];
const COURSES_PAGE_SIZE = 10;

function AdminCoursesInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [courses, setCourses] = useState<any[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [coursesError, setCoursesError] = useState<unknown>(null);
  const [totalCourses, setTotalCourses] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestLoad = useRef(0);
  const [form, setForm] = useState<{
    name: string; code: string; credits: string; semester: string; type: CourseType; department_id: string; description: string;
  }>({
    name: "", code: "", credits: "3", semester: "1", type: "core", department_id: "", description: "",
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCourses(query); }, [query]);

  useEffect(() => {
    if (searchParams.get("action") === "create") setShowCreate(true);
  }, [searchParams]);

  const departmentsResource = useAsyncResource(
    async () => requireRows(await supabase.from("departments").select("id, name, code")),
    []
  );
  const departments: any[] = departmentsResource.data ?? [];

  // The latest query's page; a failed load is an error in the table, never
  // "No courses found." (owner decision D5).
  const loadCourses = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setCoursesLoading(true);
    setCoursesError(null);
    try {
      const { data, count } = await listCourses(q);
      if (run !== latestLoad.current) return;
      setCourses(data);
      setTotalCourses(count);
    } catch (e) {
      if (run === latestLoad.current) setCoursesError(e);
    } finally {
      if (run === latestLoad.current) setCoursesLoading(false);
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createCourse(form.name, form.code, form.department_id, parseInt(form.credits), parseInt(form.semester), form.type, form.description || undefined);
      setForm({ name: "", code: "", credits: "3", semester: "1", type: "core", department_id: "", description: "" });
      setShowCreate(false);
      setNotice(`Course ${form.code} created.`);
      void loadCourses(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to create course."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Courses</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage all courses across departments</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Course</Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The create dialog shows its own failure. */}
      <ErrorAlert error={!showCreate ? error : null} />

      <DataTable
        columns={[
          { key: "code", header: "Code", sortable: true, render: (row: any) => <span className="font-mono text-secondary font-semibold">{row.code}</span> },
          { key: "name", header: "Course Name", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "department", header: "Department", render: (row: any) => <span className="text-on-surface-variant">{(row.departments as any)?.name || "—"}</span> },
          { key: "credits", header: "Credits", sortable: true },
          { key: "semester", header: "Sem", sortable: true },
          { key: "type", header: "Type", render: (row: any) => <span className="capitalize text-on-surface-variant">{row.type}</span> },
          // The Instructor column is gone rather than repointed: a catalog
          // course has no single teacher after 047, each offering names its
          // own, and showing one invited the exact confusion the offering
          // model exists to remove.
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={courses}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search courses..."
        emptyMessage="No courses found."
        serverMode
        totalCount={totalCourses}
        loading={coursesLoading}
        error={coursesError}
        onRetry={() => loadCourses(query)}
        onQueryChange={setQuery}
        pageSize={COURSES_PAGE_SIZE}
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Course"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading} aria-busy={loading || undefined}>{loading ? "Creating..." : "Create Course"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <Alert
          tone="error"
          className="mb-md"
          action={<Button variant="outline" size="sm" onClick={departmentsResource.reload}>Try again</Button>}
        >
          {departmentsResource.status === "error" ? (
            <>
              Departments couldn&apos;t be loaded, so none can be chosen yet.
            </>
          ) : null}
        </Alert>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
          <FormField label="Course Name" id="course_name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Data Structures" required />
          <FormField label="Course Code" id="course_code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} placeholder="e.g. CS201" required />
          <FormField label="Department" id="course_dept" type="select" value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v })} options={departments.map(d => ({ value: d.id, label: `${d.code} — ${d.name}` }))} required />
          <FormField label="Type" id="course_type" type="select" value={form.type} onChange={(v) => setForm({ ...form, type: v as CourseType })} options={[
            { value: "core", label: "Core" }, { value: "elective", label: "Elective" },
            { value: "lab", label: "Lab" }, { value: "project", label: "Project" }, { value: "seminar", label: "Seminar" },
          ]} />
          <FormField label="Credits" id="course_credits" type="number" value={form.credits} onChange={(v) => setForm({ ...form, credits: v })} />
          <FormField label="Semester" id="course_sem" type="number" value={form.semester} onChange={(v) => setForm({ ...form, semester: v })} />
          <div className="md:col-span-2">
            <FormField label="Description" id="course_desc" type="textarea" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="Course description..." />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function AdminCourses() {
  return (
    <Suspense>
      <AdminCoursesInner />
    </Suspense>
  );
}
