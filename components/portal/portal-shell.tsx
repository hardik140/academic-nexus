"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import { cn, getInitials } from "@/lib/utils";

interface PortalShellProps {
  profile: Tables<"profiles">;
  children: React.ReactNode;
}

/** Navigation items per role */
const NAV_MAP: Record<
  string,
  Array<{ label: string; href: string; icon: string }>
> = {
  student: [
    { label: "Dashboard", href: "/student/dashboard", icon: "📊" },
    { label: "Schedule", href: "/student/schedule", icon: "📅" },
    { label: "Courses", href: "/student/courses", icon: "📚" },
    { label: "Attendance", href: "/student/attendance", icon: "✅" },
    { label: "Fees", href: "/student/fees", icon: "💰" },
    { label: "Grades", href: "/student/grades", icon: "📝" },
    { label: "Hostel", href: "/student/hostel", icon: "🏠" },
    { label: "Gate Pass", href: "/student/gatepass", icon: "🚪" },
    { label: "Complaints", href: "/student/complaints", icon: "🛠️" },
  ],
  teacher: [
    { label: "Dashboard", href: "/teacher/dashboard", icon: "📊" },
    { label: "My Courses", href: "/teacher/courses", icon: "📚" },
    { label: "Attendance", href: "/teacher/attendance", icon: "✅" },
    { label: "Grading", href: "/teacher/grading", icon: "📝" },
    { label: "Timetable", href: "/teacher/timetable", icon: "📅" },
    { label: "Leave", href: "/teacher/leave", icon: "🏖️" },
  ],
  hod: [
    { label: "Dashboard", href: "/hod/dashboard", icon: "📊" },
    { label: "Approvals", href: "/hod/approvals", icon: "✅" },
    { label: "Team", href: "/hod/team", icon: "✉️" },
    { label: "Faculty", href: "/hod/faculty", icon: "👥" },
    { label: "Courses", href: "/hod/courses", icon: "📚" },
    { label: "Reports", href: "/hod/reports", icon: "📈" },
  ],
  finance: [
    { label: "Dashboard", href: "/finance/dashboard", icon: "📊" },
    { label: "Transactions", href: "/finance/transactions", icon: "💳" },
    { label: "Invoices", href: "/finance/invoices", icon: "🧾" },
    { label: "Scholarships", href: "/finance/scholarships", icon: "🎓" },
    { label: "Reports", href: "/finance/reports", icon: "📈" },
  ],
  director: [
    { label: "Dashboard", href: "/director/dashboard", icon: "📊" },
    { label: "Analytics", href: "/director/analytics", icon: "📈" },
    { label: "Departments", href: "/director/departments", icon: "🏢" },
    { label: "Team", href: "/director/team", icon: "✉️" },
    { label: "Faculty", href: "/director/faculty", icon: "👥" },
    { label: "Placements", href: "/director/placements", icon: "💼" },
  ],
  admin: [
    { label: "Dashboard", href: "/admin/dashboard", icon: "📊" },
    { label: "Users", href: "/admin/users", icon: "👥" },
    { label: "Roles", href: "/admin/roles", icon: "🔐" },
    { label: "Departments", href: "/admin/departments", icon: "🏢" },
    { label: "Hostel", href: "/admin/hostel", icon: "🏠" },
    { label: "Courses", href: "/admin/courses", icon: "📚" },
    { label: "Web Forms", href: "/admin/forms", icon: "📋" },
    { label: "Audit Log", href: "/admin/audit", icon: "📜" },
    { label: "Settings", href: "/admin/settings", icon: "⚙️" },
  ],
  warden: [
    { label: "Dashboard", href: "/warden/dashboard", icon: "📊" },
    { label: "Rooms", href: "/warden/rooms", icon: "🏠" },
    { label: "Gate Passes", href: "/warden/gatepasses", icon: "🚪" },
    { label: "Complaints", href: "/warden/complaints", icon: "🛠️" },
  ],
  super_admin: [
    { label: "Dashboard", href: "/super-admin/dashboard", icon: "📊" },
    { label: "Colleges", href: "/super-admin/colleges", icon: "🏛️" },
  ],
};

export function PortalShell({ profile, children }: PortalShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const navItems = NAV_MAP[profile.role] || NAV_MAP.student;

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const roleLabel: Record<string, string> = {
    student: "Student Portal",
    teacher: "Faculty Portal",
    hod: "HOD Portal",
    finance: "Finance Portal",
    director: "Director Portal",
    admin: "System Admin",
    warden: "Warden Portal",
    super_admin: "Super Admin",
  };

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      {/* ─── Mobile overlay ─── */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 bg-black/40 z-40 lg:hidden cursor-default"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ─── Sidebar ─── */}
      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 z-50 flex flex-col bg-surface-container-lowest border-r border-outline-variant transition-all duration-300",
          sidebarOpen ? "w-64" : "w-[72px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-sm h-16 px-md border-b border-outline-variant">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-secondary flex items-center justify-center text-on-secondary font-bold text-sm shadow-md">
            AN
          </div>
          {sidebarOpen && (
            <div className="min-w-0">
              <div className="text-sm font-bold text-on-surface truncate">
                Academic Nexus
              </div>
              <div className="text-[11px] text-outline truncate">
                {roleLabel[profile.role] || "Portal"}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-md px-sm space-y-xs">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-sm px-md py-[10px] rounded-xl text-sm font-medium transition-all",
                  isActive
                    ? "bg-secondary text-on-secondary shadow-md"
                    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                )}
              >
                <span className="text-base shrink-0">{item.icon}</span>
                {sidebarOpen && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Sidebar footer: user info */}
        <div className="border-t border-outline-variant p-md">
          <div className="flex items-center gap-sm">
            {profile.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={profile.full_name}
                className="w-9 h-9 rounded-full object-cover ring-2 ring-outline-variant"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-secondary text-on-secondary flex items-center justify-center text-xs font-bold">
                {getInitials(profile.full_name)}
              </div>
            )}
            {sidebarOpen && (
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-on-surface truncate">
                  {profile.full_name}
                </div>
                <div className="text-[11px] text-outline truncate">
                  {profile.email}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ─── Main Content Area ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-16 bg-surface-container-lowest border-b border-outline-variant flex items-center justify-between px-lg shrink-0">
          <div className="flex items-center gap-md">
            {/* Mobile hamburger */}
            <button
              aria-label="Open menu"
              className="lg:hidden p-xs rounded-lg hover:bg-surface-container-high"
              onClick={() => setMobileOpen(true)}
            >
              <svg
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="4" x2="20" y1="12" y2="12" />
                <line x1="4" x2="20" y1="6" y2="6" />
                <line x1="4" x2="20" y1="18" y2="18" />
              </svg>
            </button>

            {/* Sidebar toggle */}
            <button
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              className="hidden lg:block p-xs rounded-lg hover:bg-surface-container-high text-on-surface-variant"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <svg
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>

            {/* Breadcrumb */}
            <div className="text-sm text-on-surface-variant">
              <span className="font-semibold text-on-surface capitalize">
                {pathname.split("/").filter(Boolean).pop() || "Dashboard"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-sm">
            {/* Notifications bell */}
            <button aria-label="Notifications" className="relative p-sm rounded-xl hover:bg-surface-container-high transition-colors">
              <svg
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-on-surface-variant"
              >
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              <span className="absolute top-1 right-1 w-2 h-2 bg-error rounded-full" />
            </button>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="px-md py-xs text-xs font-medium text-on-surface-variant hover:text-error bg-surface-container-low hover:bg-error-container rounded-lg transition-colors"
            >
              Sign Out
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-lg">{children}</main>
      </div>
    </div>
  );
}
