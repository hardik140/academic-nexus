"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/ui/modal";
import { formatPct } from "@/lib/utils";

export interface PriorityAction {
  source: string;
  title: string;
  priority: "high" | "medium" | "low";
  href: string;
}

interface TeacherDashboardClientProps {
  profile: any;
  courses: any[];
  todaySlots: any[];
  totalStudents: number;
  avgAttendancePct: number | null;
  actions: PriorityAction[];
  notifications: any[];
  todayLabel: string;
}

export function TeacherDashboardClient({
  profile,
  courses,
  todaySlots,
  totalStudents,
  avgAttendancePct,
  actions,
  notifications,
  todayLabel,
}: TeacherDashboardClientProps) {
  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          Welcome, {profile?.full_name?.split(" ")[0] || "Professor"} 👋
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Faculty Dashboard • {todayLabel}
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">My Courses</div>
          <div className="text-3xl font-extrabold text-on-surface">{courses.length}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Today&apos;s Classes</div>
          <div className="text-3xl font-extrabold text-secondary">{todaySlots.length}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Students</div>
          <div className="text-3xl font-extrabold text-on-surface">{totalStudents}</div>
          <div className="text-[11px] text-outline mt-xs">across all courses</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Avg Attendance</div>
          <div className="text-3xl font-extrabold text-success">
            {avgAttendancePct != null ? formatPct(avgAttendancePct, 1) : "—"}
          </div>
        </div>
      </div>

      {/* Priority Actions */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">Priority Actions</h2>
          <span className="text-xs font-semibold text-outline">{actions.length} item{actions.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="divide-y divide-outline-variant">
          {actions.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">Nothing needs your attention right now.</div>
          ) : (
            actions.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-outline uppercase tracking-wider">{item.source}</div>
                  <div className="text-sm font-medium text-on-surface truncate">{item.title}</div>
                </div>
                <StatusBadge status={item.priority} className="shrink-0" />
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Today's Classes */}
      {todaySlots.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Today&apos;s Classes</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {todaySlots.map((slot: any) => (
              <div key={slot.id} className="flex items-center justify-between px-lg py-md">
                <div>
                  <div className="text-sm font-semibold text-on-surface">📚 {slot.courses?.code} — {slot.courses?.name}</div>
                  <div className="text-xs text-outline mt-xs">
                    🕐 {slot.start_time?.slice(0, 5)} – {slot.end_time?.slice(0, 5)}
                    {slot.room && ` • 📍 Room ${slot.room}`}
                  </div>
                </div>
                <Link href={`/teacher/attendance?course=${slot.course_id}`} className="text-xs font-semibold text-secondary hover:underline">
                  Mark Attendance →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Courses Grid */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">My Courses</h2>
          <Link href="/teacher/courses" className="text-xs font-medium text-secondary hover:underline">
            View All →
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md p-lg">
          {courses.length > 0 ? (
            courses.map((course: any) => (
              <Link
                key={course.id}
                href={`/teacher/courses/${course.id}`}
                className="bg-surface-container-low border border-outline-variant rounded-xl p-md hover:shadow-md transition-shadow block"
              >
                <div className="flex items-center gap-sm mb-sm">
                  <span className="text-xl">📚</span>
                  <div>
                    <div className="text-sm font-bold text-on-surface">{course.code}</div>
                    <div className="text-xs text-outline">{course.name}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-md pt-sm border-t border-outline-variant">
                  <span className="text-xs text-outline">
                    {course.credits} credits • Sem {course.semester}
                  </span>
                  <span className="text-xs font-semibold text-secondary">Class Pulse →</span>
                </div>
              </Link>
            ))
          ) : (
            <div className="col-span-full p-xl text-center text-sm text-outline">
              No courses assigned yet.
            </div>
          )}
        </div>
      </div>

      {notifications && notifications.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Notifications</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {notifications.map((n) => (
              <div key={n.id} className="px-lg py-md">
                <div className="text-sm font-medium text-on-surface">{n.title}</div>
                <div className="text-xs text-outline mt-xs">{n.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
