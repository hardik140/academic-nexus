"use client";

import { useState, useEffect } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { listFaculty } from "./actions";

const FACULTY_PAGE_SIZE = 10;

export default function DirectorFaculty() {
  const [faculty, setFaculty] = useState<any[]>([]);
  const [facultyLoading, setFacultyLoading] = useState(false);
  const [totalFaculty, setTotalFaculty] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFaculty(query); }, [query]);

  const loadFaculty = async (q: DataTableQuery) => {
    setFacultyLoading(true);
    const { data, count } = await listFaculty(q);
    setFaculty(data);
    setTotalFaculty(count);
    setFacultyLoading(false);
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
          // Not sortable in server mode: course_count is a client-side join
          // tally, not a real profiles column — the server can't .order() by it.
          { key: "course_count", header: "Courses" },
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
