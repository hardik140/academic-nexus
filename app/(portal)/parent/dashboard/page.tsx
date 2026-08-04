import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatPct } from "@/lib/utils";

export default async function ParentDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  // Children are matched by the parent's email against students.parent_email —
  // there is no dedicated parent-child link table yet.
  const { data: children } = await supabase
    .from("students")
    .select("*, profiles:user_id(full_name), departments(name, code)")
    .eq("parent_email", profile?.email || "");

  const childIds = (children || []).map((c: any) => c.id);

  const [attendanceRes, feesRes] = await Promise.all([
    childIds.length ? supabase.from("attendance").select("student_id, status").in("student_id", childIds) : Promise.resolve({ data: [] }),
    childIds.length ? supabase.from("fees").select("student_id, amount, paid_amount, status").in("student_id", childIds) : Promise.resolve({ data: [] }),
  ]);

  const attendanceByChild: Record<string, { present: number; total: number }> = {};
  (attendanceRes.data || []).forEach((a: any) => {
    if (!attendanceByChild[a.student_id]) attendanceByChild[a.student_id] = { present: 0, total: 0 };
    attendanceByChild[a.student_id].total++;
    if (a.status === "present" || a.status === "late") attendanceByChild[a.student_id].present++;
  });

  const feesByChild: Record<string, number> = {};
  (feesRes.data || []).forEach((f: any) => {
    feesByChild[f.student_id] = (feesByChild[f.student_id] || 0) + (f.amount - f.paid_amount);
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Parent Dashboard</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Overview of your child&apos;s academics, attendance, and fees</p>
      </div>

      {(children || []).length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
          {(children || []).map((child: any) => {
            const att = attendanceByChild[child.id];
            const attPct = att && att.total > 0 ? (att.present / att.total) * 100 : 0;
            const due = feesByChild[child.id] || 0;
            return (
              <div key={child.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
                <div className="flex items-center justify-between mb-md">
                  <div>
                    <h3 className="text-sm font-bold text-on-surface">{(child.profiles as any)?.full_name}</h3>
                    <p className="text-xs text-outline">{(child.departments as any)?.name} • Semester {child.semester}</p>
                  </div>
                  <span className="text-xs font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary">{child.enrollment_number}</span>
                </div>
                <div className="grid grid-cols-3 gap-sm">
                  <div className="bg-surface-container-low rounded-xl p-md text-center">
                    <div className="text-xs text-outline uppercase tracking-wider mb-xs">Attendance</div>
                    <div className={`text-lg font-bold ${attPct >= 75 ? "text-success" : "text-error"}`}>{formatPct(attPct, 0)}</div>
                  </div>
                  <div className="bg-surface-container-low rounded-xl p-md text-center">
                    <div className="text-xs text-outline uppercase tracking-wider mb-xs">CGPA</div>
                    <div className="text-lg font-bold text-secondary">{child.cgpa || "—"}</div>
                  </div>
                  <div className="bg-surface-container-low rounded-xl p-md text-center">
                    <div className="text-xs text-outline uppercase tracking-wider mb-xs">Fee Due</div>
                    <div className={`text-lg font-bold ${due > 0 ? "text-warning" : "text-success"}`}>₹{due.toLocaleString()}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-2xl text-center">
          <div className="text-4xl mb-md">👨‍👩‍👧</div>
          <h2 className="text-sm font-bold text-on-surface mb-xs">No linked children found</h2>
          <p className="text-sm text-on-surface-variant max-w-md mx-auto">
            No student record lists <span className="font-medium text-on-surface">{profile?.email}</span> as a parent
            contact yet. Ask the school office to add this email to your child&apos;s profile.
          </p>
        </div>
      )}
    </div>
  );
}
