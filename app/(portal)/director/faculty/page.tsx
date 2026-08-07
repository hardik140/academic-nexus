"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_QUERY_LIMIT } from "@/lib/constants";

export default function DirectorFaculty() {
  const supabase = createClient();
  const [faculty, setFaculty] = useState<any[]>([]);

  useEffect(() => { loadFaculty(); }, []);

  const loadFaculty = async () => {
    const [facultyRes, coursesRes] = await Promise.all([
      supabase.from("profiles").select("*, departments:department_id(name, code)").in("role", ["teacher", "hod"]).order("full_name").limit(DEFAULT_QUERY_LIMIT),
      // Course catalog, not a per-transaction table — 2x the default cap is
      // ample headroom while still keeping the instructor course-count tally
      // (below) from silently undercounting under normal growth.
      supabase.from("courses").select("id, instructor_id").limit(DEFAULT_QUERY_LIMIT * 2),
    ]);

    const courseCounts: Record<string, number> = {};
    (coursesRes.data || []).forEach((c: any) => {
      if (!c.instructor_id) return;
      courseCounts[c.instructor_id] = (courseCounts[c.instructor_id] || 0) + 1;
    });
    setFaculty((facultyRes.data || []).map((f: any) => ({ ...f, course_count: courseCounts[f.id] || 0 })));
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Faculty</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide faculty directory and workload</p>
      </div>

      <DataTable
        columns={[
          {
            key: "full_name",
            header: "Name",
            sortable: true,
            render: (row: any) => (
              <div className="flex items-center gap-sm">
                <div className="w-7 h-7 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-[10px] font-bold shrink-0">
                  {row.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                </div>
                <span className="font-medium text-on-surface">{row.full_name}</span>
              </div>
            ),
          },
          { key: "role", header: "Role", render: (row: any) => <span className="capitalize text-on-surface-variant">{row.role}</span> },
          { key: "department", header: "Department", render: (row: any) => (row.departments as any)?.name || "—" },
          { key: "course_count", header: "Courses", sortable: true },
          {
            key: "status",
            header: "Status",
            render: (row: any) => (
              <span className={`text-xs font-semibold px-sm py-xs rounded-full ${row.status === "active" ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}>{row.status}</span>
            ),
          },
        ]}
        data={faculty}
        keyExtractor={(row) => row.id}
        searchKey="full_name"
        searchPlaceholder="Search by name, department, or role..."
        emptyMessage="No faculty records found."
      />
    </div>
  );
}
