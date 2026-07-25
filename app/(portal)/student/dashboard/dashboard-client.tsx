"use client";

import { formatCurrency, formatDate, formatPct } from "@/lib/utils";

interface StudentDashboardClientProps {
  profile: any;
  student: any;
  attendance: any[];
  fees: any[];
  notifications: any[];
}

export function StudentDashboardClient({
  profile,
  student,
  attendance,
  fees,
  notifications,
}: StudentDashboardClientProps) {
  // Compute metrics
  const totalClasses = attendance.length || 1;
  const presentCount = attendance.filter(
    (a) => a.status === "present" || a.status === "late"
  ).length;
  const attendancePct = (presentCount / totalClasses) * 100;
  const totalFeesDue = fees.reduce(
    (sum: number, f: any) => sum + (f.amount - f.paid_amount),
    0
  );
  const cgpa = student?.cgpa || 0;
  const credits = student?.credits_completed || 0;
  const creditsRequired = student?.credits_required || 160;

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          Welcome back, {profile?.full_name?.split(" ")[0] || "Student"} 👋
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Semester {student?.semester || 1} • Batch{" "}
          {student?.batch_year || new Date().getFullYear()}
        </p>
      </div>

      {/* ─── KPI Cards (Bento Grid) ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        {/* CGPA */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-shadow">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            CGPA
          </div>
          <div className="text-3xl font-extrabold text-on-surface">
            {cgpa.toFixed(2)}
          </div>
          <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div
              className="h-full bg-success rounded-full transition-all duration-700"
              style={{ width: `${(cgpa / 10) * 100}%` }}
            />
          </div>
          <div className="text-[11px] text-outline mt-xs">
            out of 10.00
          </div>
        </div>

        {/* Attendance */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-shadow">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            Attendance
          </div>
          <div
            className={`text-3xl font-extrabold ${
              attendancePct >= 75 ? "text-success" : "text-error"
            }`}
          >
            {formatPct(attendancePct, 0)}
          </div>
          <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${
                attendancePct >= 75 ? "bg-success" : "bg-error"
              }`}
              style={{ width: `${Math.min(attendancePct, 100)}%` }}
            />
          </div>
          <div className="text-[11px] text-outline mt-xs">
            {presentCount}/{totalClasses} classes
          </div>
        </div>

        {/* Credits */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-shadow">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            Credits
          </div>
          <div className="text-3xl font-extrabold text-on-surface">
            {credits}
          </div>
          <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div
              className="h-full bg-info rounded-full transition-all duration-700"
              style={{
                width: `${(credits / creditsRequired) * 100}%`,
              }}
            />
          </div>
          <div className="text-[11px] text-outline mt-xs">
            of {creditsRequired} required
          </div>
        </div>

        {/* Fees Due */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-shadow">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            Fees Due
          </div>
          <div
            className={`text-3xl font-extrabold ${
              totalFeesDue > 0 ? "text-warning" : "text-success"
            }`}
          >
            {totalFeesDue > 0 ? formatCurrency(totalFeesDue) : "Clear"}
          </div>
          <div className="text-[11px] text-outline mt-sm">
            {fees.length} pending invoice{fees.length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* ─── Two Column Layout ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">
        {/* Recent Attendance */}
        <div className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">
              Recent Attendance
            </h2>
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
                  <span
                    className={`text-xs font-semibold px-sm py-xs rounded-full ${
                      record.status === "present"
                        ? "bg-success/10 text-success"
                        : record.status === "late"
                        ? "bg-warning/10 text-warning"
                        : record.status === "excused"
                        ? "bg-info/10 text-info"
                        : "bg-error/10 text-error"
                    }`}
                  >
                    {record.status}
                  </span>
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
                      <span
                        className={`text-xs font-semibold px-sm py-xs rounded-full ${
                          fee.status === "overdue"
                            ? "bg-error/10 text-error"
                            : fee.status === "partial"
                            ? "bg-warning/10 text-warning"
                            : "bg-info/10 text-info"
                        }`}
                      >
                        {fee.status}
                      </span>
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
