"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { createCourse } from "./actions";
import type { Database } from "@/types/database";

type CourseType = Database["public"]["Tables"]["courses"]["Row"]["type"];

function AdminCoursesInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [courses, setCourses] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{
    name: string; code: string; credits: string; semester: string; type: CourseType; department_id: string; description: string;
  }>({
    name: "", code: "", credits: "3", semester: "1", type: "core", department_id: "", description: "",
  });

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (searchParams.get("action") === "create") setShowCreate(true);
  }, [searchParams]);

  const loadData = async () => {
    const [coursesRes, deptsRes] = await Promise.all([
      supabase.from("courses").select("*, departments:department_id(name), profiles:instructor_id(full_name)").order("code"),
      supabase.from("departments").select("id, name, code"),
    ]);
    setCourses(coursesRes.data || []);
    setDepartments(deptsRes.data || []);
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createCourse(form.name, form.code, form.department_id, parseInt(form.credits), parseInt(form.semester), form.type, form.description || undefined);
      setForm({ name: "", code: "", credits: "3", semester: "1", type: "core", department_id: "", description: "" });
      setShowCreate(false);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create course.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Courses</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage all courses across departments</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Course</Button>
      </div>

      {error && !showCreate && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <DataTable
        columns={[
          { key: "code", header: "Code", sortable: true, render: (row: any) => <span className="font-mono text-secondary font-semibold">{row.code}</span> },
          { key: "name", header: "Course Name", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "department", header: "Department", render: (row: any) => <span className="text-on-surface-variant">{(row.departments as any)?.name || "—"}</span> },
          { key: "credits", header: "Credits", sortable: true },
          { key: "semester", header: "Sem", sortable: true },
          { key: "type", header: "Type", render: (row: any) => <span className="capitalize text-on-surface-variant">{row.type}</span> },
          { key: "instructor", header: "Instructor", render: (row: any) => <span className="text-on-surface-variant">{(row.profiles as any)?.full_name || "TBA"}</span> },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={courses}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search courses..."
        emptyMessage="No courses found."
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Course"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading}>{loading ? "Creating..." : "Create Course"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
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
