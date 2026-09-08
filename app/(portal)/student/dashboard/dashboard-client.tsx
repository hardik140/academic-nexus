"use client";

import Link from "next/link";
import { formatCurrency, formatDate, formatPct } from "@/lib/utils";
import { HealthGauge } from "@/components/charts/health-gauge";
import { StatusBadge } from "@/components/ui/modal";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import type { AcademicHealthResult, SubjectRiskResult } from "@/lib/academic-scoring";

interface SubjectRiskEntry {
  course: { id: string; name: string; code: string } | null;
  risk: SubjectRiskResult;
}

interface StudentDashboardClientProps {
  profile: any;
  student: any;
  attendance: any[];
  fees: any[];
  notifications: any[];
  academicHealth: AcademicHealthResult;
  subjectRisks: SubjectRiskEntry[];
  upcomingPlacementDeadlines: any[];
}

const PROFILE_FIELDS = [
  "phone",
  "avatar_url",
  "date_of_birth",
  "gender",
  "address",
  "city",
  "state",
  "pincode",
  "emergency_contact_name",
  "emergency_contact_phone",
];

type Priority = "high" | "medium" | "low";

interface ActionItem {
  source: string;
  title: string;
  deadline?: string;
  priority: Priority;
  href: string;
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function StudentDashboardClient({
  profile,
  student,
  attendance,
  fees,
  notifications,
  academicHealth,
  subjectRisks,
  upcomingPlacementDeadlines,
}: StudentDashboardClientProps) {
  const totalFeesDue = fees.reduce((sum: number, f: any) => sum + (f.amount - f.paid_amount), 0);
  const cgpa = student?.cgpa || 0;
  const credits = student?.credits_completed || 0;
  const creditsRequired = student?.credits_required || 160;

  const filledFields = PROFILE_FIELDS.filter((f) => profile?.[f]).length;
  const profileCompletionPct = Math.round((filledFields / PROFILE_FIELDS.length) * 100);

  const riskyCourses = subjectRisks.filter((r) => r.risk.level !== "low");

  const actionItems: ActionItem[] = [
    ...fees.map((f: any) => ({
      source: "Fees",
      title: `${f.type} payment due`,
      deadline: f.due_date,
      priority: (computeEffectiveFeeStatus(f) === "overdue" ? "high" : "medium") as Priority,
      href: "/student/fees",
    })),
    ...upcomingPlacementDeadlines.slice(0, 5).map((d: any) => ({
      source: "Placement",
      title: `Apply — ${d.job_role} at ${d.companies?.name || "company"}`,
      deadline: d.application_deadline,
      priority: (daysUntil(d.application_deadline) <= 2 ? "high" : "medium") as Priority,
      href: "/student/placements",
    })),
    ...riskyCourses
      .filter((r) => r.risk.level === "high")
      .map((r) => ({
        source: "Attendance",
        title: `${r.course?.name || "A course"} attendance at risk`,
        priority: "high" as Priority,
        href: "/student/attendance",
      })),
  ];
  actionItems.sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    if (a.deadline && b.deadline) return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    return a.deadline ? -1 : b.deadline ? 1 : 0;
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
            Welcome back, {profile?.full_name?.split(" ")[0] || "Student"} 👋
          </h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Semester {student?.semester || 1} • Batch {student?.batch_year || new Date().getFullYear()}
          </p>
        </div>
        {profileCompletionPct < 100 && (
          <span className="text-xs font-semibold text-on-surface-variant bg-surface-container-low px-md py-sm rounded-xl">
            Profile {profileCompletionPct}% complete
          </span>
        )}
      </div>

      {/* ─── Academic Health + Today's Actions ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
          <h2 className="text-sm font-bold text-on-surface mb-sm">Academic Health</h2>
          <HealthGauge
            score={academicHealth.score}
            label="Academic Health"
            contributingCount={academicHealth.contributingCount}
            possibleCount={academicHealth.possibleCount}
            emptyStateMessage="No score yet — attendance, grades, and enrollment records will feed this in as your semester progresses."
          />
          <div className="mt-sm text-[11px] text-outline space-y-[2px]">
            <div>Attendance: {academicHealth.breakdown.attendancePct != null ? formatPct(academicHealth.breakdown.attendancePct, 0) : "—"}</div>
            <div>CGPA: {cgpa.toFixed(2)} / 10.00</div>
            <div>Credits: {credits} of {creditsRequired}</div>
          </div>
          <Link href="/student/insights" className="inline-block mt-md text-xs font-semibold text-secondary hover:underline">
            View full Academic Intelligence →
          </Link>
        </div>

        <div className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">Today&apos;s Actions</h2>
            <span className="text-xs font-semibold text-outline">{actionItems.length} item{actionItems.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="divide-y divide-outline-variant">
            {actionItems.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">Nothing needs your attention right now.</div>
            ) : (
              actionItems.slice(0, 8).map((item, i) => (
                <Link
                  key={i}
                  href={item.href}
                  className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-outline uppercase tracking-wider">{item.source}</div>
                    <div className="text-sm font-medium text-on-surface truncate">{item.title}</div>
                    {item.deadline && (
                      <div className="text-xs text-outline mt-xs">Deadline: {formatDate(item.deadline)}</div>
                    )}
                  </div>
                  <StatusBadge status={item.priority} className="shrink-0" />
                </Link>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ─── Attention Required ─── */}
      {riskyCourses.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">Attention Required</h2>
            <span className="text-xs font-semibold text-outline">
              {riskyCourses.length} course{riskyCourses.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="divide-y divide-outline-variant">
            {riskyCourses.map((r) => (
              <div key={r.course?.id} className="px-lg py-md">
                <div className="flex items-center gap-sm mb-xs">
                  <StatusBadge status={r.risk.level} />
                  <span className="text-sm font-semibold text-on-surface">{r.course?.name}</span>
                </div>
                {r.risk.reasons.map((reason, i) => (
                  <div key={i} className="text-xs text-on-surface-variant mt-xs">{reason}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Two Column Layout: Recent Attendance + Notifications ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">
        <div className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Recent Attendance</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {attendance.length > 0 ? (
              attendance.slice(0, 6).map((record: any) => (
                <div
                  key={record.id}
                  className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
                >
                  <div>
                    <div className="text-sm font-medium text-on-surface">
                      {record.courses?.name || "Course"}
                    </div>
                    <div className="text-xs text-outline">
                      {record.courses?.code} • {formatDate(record.date)}
                    </div>
                  </div>
                  <StatusBadge status={record.status} />
                </div>
              ))
            ) : (
              <div className="p-xl text-center text-sm text-outline">
                No attendance records yet. They will appear here once your
                teachers start marking attendance.
              </div>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">
              Notifications
            </h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {notifications.length > 0 ? (
              notifications.map((notif: any) => (
                <div
                  key={notif.id}
                  className="px-lg py-md hover:bg-surface-container-low transition-colors"
                >
                  <div className="text-sm font-medium text-on-surface">
                    {notif.title}
                  </div>
                  <div className="text-xs text-outline mt-xs line-clamp-2">
                    {notif.message}
                  </div>
                  <div className="text-[10px] text-outline-variant mt-xs">
                    {formatDate(notif.created_at, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="p-xl text-center text-sm text-outline">
                All caught up! No new notifications.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Pending Fees Table ─── */}
      {fees.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">
              Pending Fee Payments
            </h2>
            <span className="text-xs font-semibold text-warning bg-warning/10 px-sm py-xs rounded-full">
              {fees.length} pending
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-container-low text-on-surface-variant">
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                    Type
                  </th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                    Paid
                  </th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                    Balance
                  </th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                    Due Date
                  </th>
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {fees.map((fee: any) => (
                  <tr
                    key={fee.id}
                    className="hover:bg-surface-container-low transition-colors"
                  >
                    <td className="px-lg py-md font-medium text-on-surface">
                      {fee.type}
                    </td>
                    <td className="px-lg py-md text-on-surface-variant">
                      {formatCurrency(fee.amount)}
                    </td>
                    <td className="px-lg py-md text-success">
                      {formatCurrency(fee.paid_amount)}
                    </td>
                    <td className="px-lg py-md font-semibold text-on-surface">
                      {formatCurrency(fee.amount - fee.paid_amount)}
                    </td>
                    <td className="px-lg py-md text-on-surface-variant">
                      {formatDate(fee.due_date)}
                    </td>
                    <td className="px-lg py-md">
                      <StatusBadge status={computeEffectiveFeeStatus(fee)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
