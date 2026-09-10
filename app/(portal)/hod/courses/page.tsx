"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export default function HodCourses() {
  const supabase = createClient();
  const [courses, setCourses] = useState<any[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => { loadCourses(); }, []);

  const loadCourses = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // Resolve department via departments.hod_id, same as hod/dashboard,
    // hod/reports, and hod/faculty — see the comment in hod/faculty/page.tsx
    // for why profiles.department_id isn't the right field here.
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", user.id).single();
    if (!department) {
      setCourses([]);
      return;
    }

    const { data } = await supabase
      .from("courses")
      // A catalog course has no single instructor after 047 — teaching
      // assignment belongs to each offering, so this no longer joins one.
      .select("*, departments:department_id(name)")
      .eq("department_id", department.id)
      .order("code");
    setCourses(data || []);
  };

  const filtered = courses.filter((c: any) =>
    !search ||
    c.code?.toLowerCase().includes(search.toLowerCase()) ||
    c.name?.toLowerCase().includes(search.toLowerCase()) ||
    (c.departments as any)?.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Department Courses</h1>
        <p className="text-sm text-on-surface-variant mt-xs">All courses under your department</p>
      </div>

      <div className="relative">
        <span className="absolute left-md top-1/2 -translate-y-1/2 text-outline text-sm">🔍</span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by code, name, or department..."
          className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl pl-xl pr-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
        />
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Code</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Course</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Department</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Credits</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Sem</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Type</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {filtered.map((c: any) => (
                <tr key={c.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-mono text-secondary font-semibold">{c.code}</td>
                  <td className="px-lg py-md font-medium text-on-surface">{c.name}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(c.departments as any)?.name || "—"}</td>
                  <td className="px-lg py-md">{c.credits}</td>
                  <td className="px-lg py-md">{c.semester}</td>
                  <td className="px-lg py-md capitalize text-on-surface-variant">{c.type}</td>
                  <td className="px-lg py-md">
                    <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                      c.status === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
                    }`}>{c.status}</span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-lg py-xl text-center text-outline">{courses.length === 0 ? "No courses found." : "No courses match your search."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
