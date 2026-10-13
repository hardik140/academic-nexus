"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import { cn, getInitials } from "@/lib/utils";
import { NativeDialog } from "@/components/ui/native-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { SessionsDialog } from "@/components/portal/sessions-dialog";
import { endMySessions, listMySessions, revokeMySession } from "@/lib/sessions/actions";

interface PortalShellProps {
  profile: Tables<"profiles">;
  children: React.ReactNode;
}

/** Navigation items per role */
const NAV_MAP: Record<
  string,
  Array<{ label: string; href: string; icon: string; activePath?: string }>
> = {
  student: [
    { label: "Dashboard", href: "/student/dashboard", icon: "📊" },
    { label: "Schedule", href: "/student/schedule", icon: "📅" },
    { label: "Courses", href: "/student/courses", icon: "📚" },
    { label: "Attendance", href: "/student/attendance", icon: "✅" },
    { label: "Fees", href: "/student/fees", icon: "💰" },
    { label: "Grades", href: "/student/grades", icon: "📝" },
    { label: "Insights", href: "/student/insights", icon: "🧠" },
    { label: "Hostel", href: "/student/hostel", icon: "🏠" },
    { label: "Gate Pass", href: "/student/gatepass", icon: "🚪" },
    { label: "Placement", href: "/student/placements", icon: "🎯" },
    { label: "Complaints", href: "/student/complaints", icon: "🛠️" },
  ],
  teacher: [
    { label: "Dashboard", href: "/teacher/dashboard", icon: "📊" },
    { label: "My Courses", href: "/teacher/courses", icon: "📚" },
    { label: "My Class", href: "/teacher/class", icon: "🧑‍🏫" },
    { label: "Attendance", href: "/teacher/attendance", icon: "✅" },
    { label: "Grading", href: "/teacher/grading", icon: "📝" },
    { label: "Timetable", href: "/teacher/timetable", icon: "📅" },
    { label: "Leave", href: "/teacher/leave", icon: "🏖️" },
  ],
  hod: [
    { label: "Dashboard", href: "/hod/dashboard", icon: "📊" },
    { label: "Academics", href: "/hod/academics", icon: "🏫" },
    { label: "Approvals", href: "/hod/approvals", icon: "✅" },
    { label: "Substitutions", href: "/hod/substitutions", icon: "🔄" },
    { label: "Team", href: "/hod/team", icon: "✉️" },
    { label: "Faculty", href: "/hod/faculty", icon: "👥" },
    { label: "Workload", href: "/hod/workload", icon: "⚖️" },
    { label: "Courses", href: "/hod/courses", icon: "📚" },
    { label: "Reports", href: "/hod/reports", icon: "📈" },
  ],
  finance: [
    { label: "Dashboard", href: "/finance/dashboard", icon: "📊" },
    { label: "Exceptions", href: "/finance/exceptions", icon: "🚨" },
    { label: "Refunds", href: "/finance/refunds", icon: "💸" },
    { label: "Disputes", href: "/finance/disputes", icon: "⚖️" },
    { label: "Transactions", href: "/finance/transactions", icon: "💳" },
    { label: "Invoices", href: "/finance/invoices", icon: "🧾" },
    { label: "Scholarships", href: "/finance/scholarships", icon: "🎓" },
    { label: "Reports", href: "/finance/reports", icon: "📈" },
    { label: "Integrations", href: "/finance/integrations", icon: "🔌" },
  ],
  director: [
    { label: "Dashboard", href: "/director/dashboard", icon: "📊" },
    { label: "Attention", href: "/director/attention", icon: "🚨" },
    { label: "Decisions", href: "/director/decisions", icon: "🗳️" },
    { label: "Analytics", href: "/director/analytics", icon: "📈" },
    { label: "Departments", href: "/director/departments", icon: "🏢" },
    { label: "Placements", href: "/director/placements/funnel", icon: "🎯", activePath: "/director/placements" },
    { label: "Hostel", href: "/director/hostel", icon: "🏠" },
    { label: "Gate Security", href: "/director/security", icon: "🛡️" },
    { label: "Team", href: "/director/team", icon: "✉️" },
    { label: "Faculty", href: "/director/faculty", icon: "👥" },
    { label: "Goals", href: "/director/goals", icon: "🏆" },
    { label: "Ask the Institution", href: "/director/ask", icon: "💬" },
    { label: "Forecast", href: "/director/forecast", icon: "🔮" },
    { label: "Briefing", href: "/director/briefing", icon: "📰" },
  ],
  admin: [
    { label: "Dashboard", href: "/admin/dashboard", icon: "📊" },
    { label: "Users", href: "/admin/users", icon: "👥" },
    { label: "Roles", href: "/admin/roles", icon: "🔐" },
    { label: "Departments", href: "/admin/departments", icon: "🏢" },
    { label: "Hostel", href: "/admin/hostel", icon: "🏠" },
    { label: "Courses", href: "/admin/courses", icon: "📚" },
    { label: "Academic Periods", href: "/admin/academic-periods", icon: "📅" },
    { label: "Finance Integrations", href: "/finance/integrations", icon: "🔌" },
    { label: "Web Forms", href: "/admin/forms", icon: "📋" },
    { label: "Audit Log", href: "/admin/audit", icon: "📜" },
    { label: "Settings", href: "/admin/settings", icon: "⚙️" },
  ],
  warden: [
    { label: "Dashboard", href: "/warden/dashboard", icon: "📊" },
    { label: "Rooms", href: "/warden/rooms", icon: "🏠" },
    { label: "Transfers", href: "/warden/transfers", icon: "🔄" },
    { label: "Gate Passes", href: "/warden/gatepasses", icon: "🚪" },
    { label: "Complaints", href: "/warden/complaints", icon: "🛠️" },
  ],
  super_admin: [
    { label: "Dashboard", href: "/super-admin/dashboard", icon: "📊" },
    { label: "Colleges", href: "/super-admin/colleges", icon: "🏛️" },
    { label: "System Health", href: "/super-admin/system-health", icon: "🩺" },
  ],
  gate_security: [
    { label: "Dashboard", href: "/security/dashboard", icon: "🛡️" },
    { label: "Scanner", href: "/security/scanner", icon: "📷" },
    { label: "Movements", href: "/security/movements", icon: "🚦" },
  ],
  placement_cell: [
    { label: "Dashboard", href: "/placement-cell/dashboard", icon: "📊" },
    { label: "Companies", href: "/placement-cell/companies", icon: "🏢" },
    { label: "Placement Drives", href: "/placement-cell/drives", icon: "🎯" },
    { label: "Notifications", href: "/placement-cell/notifications", icon: "🔔" },
    { label: "Placement Records", href: "/placement-cell/records", icon: "📋" },
    { label: "Reports", href: "/placement-cell/reports", icon: "📈" },
  ],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Falls back to the parent segment when the last path segment is a UUID
 * (a dynamic [id] route, e.g. /director/decisions/<uuid>) — otherwise the
 * naive "last segment, capitalized" breadcrumb shows a raw record id.
 * Also turns hyphenated route segments (e.g. "placement-cell") into
 * space-separated words for readability.
 */
function breadcrumbLabel(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  let last = segments.pop() || "dashboard";
  if (UUID_PATTERN.test(last) && segments.length > 0) {
    last = segments.pop()!;
  }
  return last.replace(/-/g, " ");
}

const roleLabel: Record<string, string> = {
  student: "Student Portal",
  teacher: "Faculty Portal",
  hod: "HOD Portal",
  finance: "Finance Portal",
  director: "Director Portal",
  admin: "System Admin",
  warden: "Warden Portal",
  super_admin: "Super Admin",
  placement_cell: "Placement Cell Portal",
  gate_security: "Gate Security",
};

/** The navigation panel: the desktop sidebar and the mobile drawer render the same one. */
export function SidebarContent({
  profile,
  pathname,
  expanded,
  onNavigate,
  onClose,
}: {
  profile: Tables<"profiles">;
  pathname: string;
  expanded: boolean;
  /** Every click on a navigation link: closes the drawer, and may start the pending marker. */
  onNavigate: (href: string, event: React.MouseEvent<HTMLAnchorElement>) => void;
  /** The drawer's close control; the desktop sidebar has none. */
  onClose?: () => void;
}) {
  const navItems = NAV_MAP[profile.role] || NAV_MAP.student;
  // Match whole path segments; the most specific section is the sole current link.
  const currentItem = navItems
    .filter((item) => {
      const path = item.activePath ?? item.href;
      return pathname === path || pathname.startsWith(`${path}/`);
    })
    .sort((a, b) => (b.activePath ?? b.href).length - (a.activePath ?? a.href).length)[0];

  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-sm h-16 px-md border-b border-outline-variant">
        <div className="shrink-0 w-10 h-10 rounded-xl bg-secondary flex items-center justify-center text-on-secondary font-bold text-sm shadow-md">
          AN
        </div>
        {expanded && (
          <div className="min-w-0">
            <div className="text-sm font-bold text-on-surface truncate">
              Academic Nexus
            </div>
            <div className="text-[11px] text-outline truncate">
              {roleLabel[profile.role] || "Portal"}
            </div>
          </div>
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="ml-auto shrink-0 p-xs rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface motion-feedback"
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
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-md px-sm space-y-xs">
        {navItems.map((item) => {
          const isActive = item === currentItem;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              onClick={(event) => onNavigate(item.href, event)}
              className={cn(
                "flex items-center gap-sm px-md py-[10px] rounded-xl text-sm font-medium motion-feedback",
                isActive
                  ? "bg-secondary text-on-secondary shadow-md"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              )}
            >
              <span aria-hidden="true" className="text-base shrink-0">{item.icon}</span>
              <span className={expanded ? "truncate" : "sr-only"}>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Sidebar footer: user info */}
      <div className="border-t border-outline-variant p-md">
        <div className="flex items-center gap-sm">
          {profile.avatar_url ? (
            <Image
              src={profile.avatar_url}
              alt={profile.full_name}
              width={36}
              height={36}
              className="w-9 h-9 rounded-full object-cover ring-2 ring-outline-variant"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-secondary text-on-secondary flex items-center justify-center text-xs font-bold">
              {getInitials(profile.full_name)}
            </div>
          )}
          {expanded && (
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
    </>
  );
}

/** Tailwind's `lg` breakpoint: from here on the sidebar is persistent and the drawer is not used. */
const DESKTOP_QUERY = "(min-width: 64rem)";

/**
 * How long a navigation must still be pending before the marker shows. A
 * prefetched page arrives in about 20–65ms (measured on a production build,
 * M6); 150ms stays clear of that with room for slower devices, so a fast
 * navigation shows nothing at all, while a slow one is marked well within
 * the first second. A timer, not an animation: the marker appears at once.
 */
const PENDING_MARKER_DELAY_MS = 150;

export function PortalShell({ profile, children }: PortalShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  // The page a navigation link is loading, from the click until the route
  // changes. Owned here, not by each link, so it survives the drawer closing.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // Which pending navigation has lasted long enough to be marked.
  const [markedHref, setMarkedHref] = useState<string | null>(null);
  const markerShown = pendingHref !== null && markedHref === pendingHref;

  // Any route change closes the drawer — a link inside it, or the browser's
  // back and forward buttons — and ends any pending navigation.
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setMobileOpen(false);
    setPendingHref(null);
  }

  // Mark a navigation only once it has been pending for the delay.
  useEffect(() => {
    if (!pendingHref) return;
    const timer = setTimeout(() => setMarkedHref(pendingHref), PENDING_MARKER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pendingHref]);

  // Back or Forward abandons a pending navigation, even if it lands on the
  // same path it started from.
  useEffect(() => {
    if (!pendingHref) return;
    const abandon = () => setPendingHref(null);
    window.addEventListener("popstate", abandon);
    return () => window.removeEventListener("popstate", abandon);
  }, [pendingHref]);

  // Widening to the desktop layout closes the drawer, so a modal drawer is
  // never left open over a page that already shows the sidebar.
  useEffect(() => {
    if (!mobileOpen) return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, [mobileOpen]);

  const closeDrawer = () => setMobileOpen(false);

  const navigate = (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
    closeDrawer();
    // Only a plain same-tab navigation to another page is pending here: not a
    // modified click (new tab or window), and not the page already shown.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (href === pathname) return;
    setPendingHref(href);
  };

  const handleLogout = async () => {
    // The registry first (migration 054): signOut() ends every GoTrue
    // session of the user, so the application ends the same set.
    await endMySessions("global");
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden bg-surface">
        {/* ─── Sidebar (desktop): persistent; collapsing changes its width at once ─── */}
        <aside
          className={cn(
            "hidden lg:flex flex-col bg-surface-container-lowest border-r border-outline-variant",
            sidebarOpen ? "w-64" : "w-[72px]"
          )}
        >
          <SidebarContent profile={profile} pathname={pathname} expanded={sidebarOpen} onNavigate={navigate} />
        </aside>

        {/* ─── Navigation drawer (below desktop): a native modal dialog ─── */}
        <NativeDialog
          open={mobileOpen}
          onClose={closeDrawer}
          aria-label="Menu"
          className="motion-drawer m-0 h-dvh max-h-dvh w-64 open:flex flex-col text-inherit bg-surface-container-lowest border-r border-outline-variant backdrop:bg-black/40"
        >
          <SidebarContent profile={profile} pathname={pathname} expanded onNavigate={navigate} onClose={closeDrawer} />
        </NativeDialog>

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
                  {breadcrumbLabel(pathname)}
                </span>
              </div>

              {/* Navigation pending: static, in the header so it stays in view
                  once the mobile drawer has closed. Its space is always kept,
                  so appearing moves nothing. */}
              <span
                data-testid="nav-pending"
                className={cn("flex items-center gap-xs text-xs text-on-surface-variant", !markerShown && "invisible")}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-outline">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                Loading page…
              </span>
            </div>

            <div className="flex items-center gap-sm">
              {/* Notifications bell — wired to a real Notification Center for
                  director only in this pass (see app/(portal)/director/notifications);
                  every other role keeps the previous static, non-functional bell. */}
              {profile.role === "director" ? (
                <Link href="/director/notifications" aria-label="Notifications" className="relative p-sm rounded-xl hover:bg-surface-container-high transition-colors block">
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
                </Link>
              ) : (
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
              )}

              {/* Your devices: the user's own sessions, with "Sign out" on each (054). */}
              <button
                aria-label="Your devices"
                onClick={() => setDevicesOpen(true)}
                className="p-sm rounded-xl hover:bg-surface-container-high text-on-surface-variant motion-feedback"
              >
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="10" x="2" y="4" rx="2" />
                  <path d="M6 18h6" />
                  <rect width="6" height="10" x="16" y="8" rx="1" />
                </svg>
              </button>
              <SessionsDialog
                open={devicesOpen}
                onClose={() => setDevicesOpen(false)}
                title="Your devices"
                description="Where your account is signed in. Signing out a device ends that session immediately."
                load={listMySessions}
                revoke={revokeMySession}
                revokeLabel="Sign out"
                emptyText="Only this device is signed in."
              />

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
          <main className="flex-1 overflow-y-auto p-lg" aria-busy={pendingHref ? true : undefined}>
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
