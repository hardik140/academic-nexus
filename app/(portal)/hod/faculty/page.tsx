"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export default function HodFaculty() {
  const supabase = createClient();
  const [faculty, setFaculty] = useState<any[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => { loadFaculty(); }, []);

  const loadFaculty = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // Resolve department via departments.hod_id — same lookup hod/dashboard
    // and hod/reports use. profiles.department_id is a different field
    // (which department this person's own record belongs to) that assigning
    // someone as HOD doesn't set, so relying on it here left this page
    // broken for any real HOD account.
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", user.id).single();
    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();

    if (!department) {
      setFaculty([]);
      return;
    }

    const { data } = await supabase
      .from("profiles")
      .select("*, departments:department_id(name)")
      .eq("college_id", profile?.college_id || "")
      .eq("department_id", department.id)
      .in("role", ["teacher", "hod"])
      .order("full_name");
    setFaculty(data || []);
  };

  const filtered = faculty.filter((f: any) =>
    !search || f.full_name?.toLowerCase().includes(search.toLowerCase()) || f.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Faculty Directory</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Faculty in your department</p>
      </div>

      <div className="relative">
        <span className="absolute left-md top-1/2 -translate-y-1/2 text-outline text-sm">🔍</span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search faculty by name or email..."
          className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl pl-xl pr-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {filtered.map((f: any) => (
          <div key={f.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="flex items-center gap-sm mb-md">
              <div className="w-10 h-10 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-sm font-bold">
                {f.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
              </div>
              <div>
                <div className="text-sm font-bold text-on-surface">{f.full_name}</div>
                <div className="text-xs text-outline">{(f.departments as any)?.name || "—"}</div>
              </div>
            </div>
            <div className="space-y-xs text-xs text-outline">
              <div>✉️ {f.email}</div>
              <div>📱 {f.phone || "—"}</div>
              <div className="flex items-center gap-sm pt-xs">
                <span className={`font-semibold px-sm py-xs rounded-full capitalize ${
                  f.status === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
                }`}>{f.status}</span>
                <span className="font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">{f.role}</span>
              </div>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-full bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            {faculty.length === 0 ? "No faculty members found in your department." : "No faculty match your search."}
          </div>
        )}
      </div>
    </div>
  );
}
