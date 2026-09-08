import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCached } from "@/lib/cache";
import { RequestDecisionButton } from "@/components/portal/request-decision-modal";
import { DirectorEscalationsPanel } from "@/components/portal/director-escalations-panel";
import { listHodApprovals, listCorrectionApprovals } from "../approvals/actions";
import { listSubstitutionNeeds } from "../substitutions/actions";
import { listDepartmentFacultyWorkload } from "../faculty/actions";
import { listRiskFlags } from "@/app/(portal)/director/attention/actions";

interface AttentionItem {
  label: string;
  count: number;
  href: string;
  severity: "high" | "medium" | "low";
}

export default async function HodDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  // Get HOD's department
  const { data: department } = await supabase
    .from("departments")
    .select("*")
    .eq("hod_id", user.id)
    .single();

  const { faculty, courses } = await getCached(
    `dashboard:hod:${department?.id}:faculty-courses`,
    60,
    async () => {
      const [facultyRes, coursesRes] = await Promise.all([
        supabase.from("profiles").select("*").eq("role", "teacher").eq("department_id", department?.id || ""),
        supabase.from("courses").select("*").eq("department_id", department?.id || ""),
      ]);
      return { faculty: facultyRes.data, courses: coursesRes.data };
    }
  );

  // "What needs my attention right now?" — every number here comes from a
  // real query (listHodApprovals/listCorrectionApprovals/listSubstitutionNeeds
  // are the exact same functions /hod/approvals and /hod/substitutions use;
  // listRiskFlags/listDepartmentFacultyWorkload are already department-scoped
  // for a hod caller). Risk flags ASSIGNED to this HOD are deliberately not
  // repeated here — DirectorEscalationsPanel below already shows that feed;
  // this section covers what that panel doesn't.
  const [approvals, corrections, substitutions, workload, riskFlags] = await Promise.all([
    listHodApprovals(),
    listCorrectionApprovals(),
    listSubstitutionNeeds(),
    listDepartmentFacultyWorkload(),
    listRiskFlags(),
  ]);

  const allActionItems: AttentionItem[] = [
    { label: "faculty leave request", count: approvals.pending.length, href: "/hod/approvals", severity: "high" },
    { label: "attendance correction request", count: corrections.pending.length, href: "/hod/approvals", severity: "medium" },
    { label: "class needing a substitute", count: substitutions.needed.length, href: "/hod/substitutions", severity: "high" },
  ];
  const actionItems = allActionItems.filter((i) => i.count > 0);

  const overloadedFaculty = workload.filter((f) => f.workloadPct > 120);
  const openFlagsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const flag of riskFlags.open as any[]) {
    if (flag.severity in openFlagsBySeverity) openFlagsBySeverity[flag.severity as keyof typeof openFlagsBySeverity]++;
  }
  const totalOpenFlags = riskFlags.open.length;

  const severityStyles: Record<AttentionItem["severity"], string> = {
    high: "text-error",
    medium: "text-warning",
    low: "text-outline",
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
            {department?.name || "Department"} — HOD Dashboard
          </h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Head of Department • {profile?.full_name}
          </p>
        </div>
        <RequestDecisionButton />
      </div>

      {/* Action Required */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">Action Required</h2>
          <span className="text-xs font-semibold text-outline">{actionItems.length} item{actionItems.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="divide-y divide-outline-variant">
          {actionItems.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">🎉 Nothing needs your attention right now.</div>
          ) : (
            actionItems.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
              >
                <span className="text-sm text-on-surface">
                  <span className={`font-bold ${severityStyles[item.severity]}`}>{item.count}</span>{" "}
                  {item.label}{item.count !== 1 ? "s" : ""}
                </span>
                <span className="text-xs font-semibold text-secondary">View →</span>
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Department Exceptions — deterministic rules over real data, not AI */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Department Exceptions</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {overloadedFaculty.length > 0 && (
            <Link href="/hod/workload" className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <span className="text-sm text-on-surface">
                <span className="font-bold text-error">{overloadedFaculty.length}</span> faculty member{overloadedFaculty.length !== 1 ? "s" : ""} over 120% workload
              </span>
              <span className="text-xs font-semibold text-secondary">View →</span>
            </Link>
          )}
          {totalOpenFlags > 0 && (
            <div className="px-lg py-md">
              <div className="text-sm text-on-surface">
                <span className="font-bold text-warning">{totalOpenFlags}</span> open escalation{totalOpenFlags !== 1 ? "s" : ""} in your department
              </div>
              <div className="text-xs text-outline mt-xs">
                {openFlagsBySeverity.critical > 0 && `${openFlagsBySeverity.critical} critical · `}
                {openFlagsBySeverity.high > 0 && `${openFlagsBySeverity.high} high · `}
                {openFlagsBySeverity.medium > 0 && `${openFlagsBySeverity.medium} medium · `}
                {openFlagsBySeverity.low > 0 && `${openFlagsBySeverity.low} low`}
              </div>
            </div>
          )}
          {overloadedFaculty.length === 0 && totalOpenFlags === 0 && (
            <div className="p-xl text-center text-sm text-outline">No department exceptions detected.</div>
          )}
        </div>
      </div>

      <DirectorEscalationsPanel />

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Faculty Members</div>
          <div className="text-3xl font-extrabold text-on-surface">{faculty?.length || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Active Courses</div>
          <div className="text-3xl font-extrabold text-secondary">{courses?.length || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Dept Code</div>
          <div className="text-3xl font-extrabold text-on-surface">{department?.code || "—"}</div>
        </div>
      </div>

      {/* Faculty List */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Faculty Members</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {faculty && faculty.length > 0 ? faculty.map((f: any) => (
            <div key={f.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-center gap-sm">
                <div className="w-8 h-8 rounded-full bg-secondary text-on-secondary flex items-center justify-center text-xs font-bold">
                  {f.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                </div>
                <div>
                  <div className="text-sm font-medium text-on-surface">{f.full_name}</div>
                  <div className="text-xs text-outline">{f.email}</div>
                </div>
              </div>
              <span className={`text-xs font-semibold px-sm py-xs rounded-full ${
                f.status === "active" ? "bg-success/10 text-success" : "bg-error/10 text-error"
              }`}>{f.status}</span>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">No faculty members assigned to this department.</div>
          )}
        </div>
      </div>
    </div>
  );
}
