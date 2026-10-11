"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { classifyError, SessionExpiredError } from "@/lib/feedback-error";
import { NO_MATCH_ID, requireData, requireRows } from "@/lib/read-result";

export default function HodFaculty() {
  const supabase = createClient();
  const [search, setSearch] = useState("");

  // A failed load is an error, never "No faculty members found" (owner decision D5).
  const facultyResource = useAsyncResource(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new SessionExpiredError();
    // Resolve department via departments.hod_id — same lookup hod/dashboard
    // and hod/reports use. profiles.department_id is a different field
    // (which department this person's own record belongs to) that assigning
    // someone as HOD doesn't set, so relying on it here left this page
    // broken for any real HOD account.
    const department = requireData(await supabase.from("departments").select("id").eq("hod_id", user.id).single());
    const profile = requireData(await supabase.from("profiles").select("college_id").eq("id", user.id).single());

    if (!department) return [];

    return requireRows(
      await supabase
        .from("profiles")
        .select("*, departments:department_id(name)")
        .eq("college_id", profile?.college_id || NO_MATCH_ID)
        .eq("department_id", department.id)
        .in("role", ["teacher", "hod"])
        .order("full_name")
    ) as any[];
  }, []);
  const faculty = facultyResource.data ?? [];

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

      {!facultyResource.data && (
        facultyResource.status === "error" ? (
          <ErrorState
            {...classifyError(facultyResource.error)}
            title="Your department's faculty couldn't be loaded"
            onRetry={facultyResource.reload}
            className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
          />
        ) : (
          <LoadingState label="Loading faculty…" />
        )
      )}

      {facultyResource.data && (
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
                  f.status === "active" ? "bg-success-container text-on-success-container" : "bg-warning-container text-on-warning-container"
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
      )}
    </div>
  );
}
