"use client";

import { useEffect, useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { listFaculty } from "./actions";

const FACULTY_PAGE_SIZE = 10;

export default function DirectorFaculty() {
  const [faculty, setFaculty] = useState<any[]>([]);
  const [facultyLoading, setFacultyLoading] = useState(false);
  const [facultyError, setFacultyError] = useState<unknown>(null);
  const [, setTotalFaculty] = useState(0);
  const latestLoad = useRef(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFaculty(query); }, [query]);

  // A failed load is an error in the table, never "No faculty records found." (D5).
  const loadFaculty = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setFacultyLoading(true);
    setFacultyError(null);
    try {
      const { data, count } = await listFaculty(q);
      if (run !== latestLoad.current) return;
      setFaculty(data);
      setTotalFaculty(count);
    } catch (e) {
      if (run === latestLoad.current) setFacultyError(e);
    } finally {
      if (run === latestLoad.current) setFacultyLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
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
          // Not sortable in server mode: these are client-side join tallies,
          // not real profiles columns — the server can't .order() by them.
          { key: "course_count", header: "Courses" },
          { key: "weekly_periods", header: "Weekly Periods" },
          { key: "attendance_sessions_marked", header: "Attendance Sessions" },
          { key: "marks_entered", header: "Marks Entered" },
          {
            key: "status",
            header: "Status",
            render: (row: any) => (
              <span className={`text-xs font-semibold px-sm py-xs rounded-full ${row.status === "active" ? "bg-success-container text-on-success-container" : "bg-error-container text-on-error-container"}`}>{row.status}</span>
            ),
          },
        ]}
        data={faculty}
        loading={facultyLoading}
        error={facultyError}
        onRetry={() => loadFaculty(query)}
        keyExtractor={(row) => row.id}
        searchKey="full_name"
        searchPlaceholder="Search by name, department, or role..."
        emptyMessage="No faculty records found."
      />
    </div>
  );
}
