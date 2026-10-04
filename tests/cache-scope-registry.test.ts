import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Every cached read, its visibility scope, and the proof of that scope.
 *
 * WHY THIS EXISTS
 *
 * A cache key decides who shares an answer. A key scoped to the college is
 * only correct when every role that can reach the read sees EXACTLY the same
 * rows. This was assumed, not checked — and four reads broke it:
 *
 * - warden/rooms: admins see every room, a warden only their blocks; one
 *   college key served one warden's page to another warden or to an admin.
 * - placement-cell records, reports and dashboard: students_read_staff
 *   excludes placement_cell, and student_placement_profiles excludes
 *   director; one college key served a director's student list to the
 *   placement cell (data RLS refuses it), and vice versa.
 *
 * So the scope of every read is declared here, with the RLS policies that
 * make it uniform, and this test fails when:
 *
 * - a cached read appears that has no entry (new code must declare scope);
 * - the roles that can reach a read change (re-prove the scope);
 * - a "role" or "split" scoped read stops putting the role / user in its key;
 * - a cited RLS policy no longer exists in the migrations.
 *
 * Scopes:
 *   user     key carries the user id
 *   split    admin -> college key, the narrower role -> user key
 *   role     key carries the role (roles see different rows)
 *   college  one entry per college — `uniform` must cite the policies
 *   department  key carries the department id
 *   platform super-admin only, every college
 */

type Scope = "user" | "split" | "role" | "college" | "department" | "platform";
interface Entry {
  scope: Scope;
  /** Roles that can reach the read; "route" = a page guarded by the middleware's route prefix. */
  roles: string[] | "route";
  /** For multi-role college scope: why every role sees the same rows. */
  uniform?: string;
  /** RLS policies that `uniform` relies on (checked to exist). */
  policies?: string[];
}

const P = "app/(portal)/";
const REGISTRY: Record<string, Entry> = {
  [`${P}admin/audit/actions.ts#listAuditLogs`]: { scope: "college", roles: ["admin"] },
  [`${P}admin/courses/actions.ts#listCourses`]: {
    scope: "college",
    roles: ["admin", "hod", "director"],
    uniform: "courses and departments are readable college-wide by every role",
    policies: ["courses_read", "departments_read"],
  },
  [`${P}admin/dashboard/page.tsx#AdminDashboard`]: { scope: "college", roles: "route" },
  [`${P}admin/roles/page.tsx#AdminRoles`]: { scope: "college", roles: "route" },
  [`${P}admin/users/actions.ts#listUsers`]: { scope: "college", roles: ["admin"] },
  [`${P}director/analytics/page.tsx#DirectorAnalytics`]: {
    scope: "college",
    roles: "route",
    uniform: "materialized views filtered by college_id in the query; profiles read college-wide by director and admin",
    policies: ["profiles_read_staff_same_college"],
  },
  [`${P}director/attention/actions.ts#listRiskFlags`]: { scope: "split", roles: ["director", "hod"] },
  [`${P}director/attention/actions.ts#listMyRiskFlagAssignments`]: { scope: "user", roles: ["hod", "warden", "placement_cell", "teacher"] },
  [`${P}director/attention/actions.ts#getStudentRiskOverview`]: { scope: "split", roles: ["director", "hod"] },
  [`${P}director/dashboard/actions.ts#getDashboardStats`]: {
    scope: "college",
    roles: ["director", "admin"],
    uniform: "profiles and departments read college-wide by both roles",
    policies: ["profiles_read_staff_same_college", "departments_read"],
  },
  [`${P}director/decisions/actions.ts#listDecisions`]: { scope: "college", roles: ["director"] },
  [`${P}director/departments/performance/actions.ts#listDepartmentHealth`]: { scope: "split", roles: ["director", "hod"] },
  [`${P}director/faculty/actions.ts#listFaculty`]: { scope: "college", roles: ["director"] },
  [`${P}director/hostel/actions.ts#getHostelRollup`]: { scope: "college", roles: ["director"] },
  [`${P}director/placement-cell/actions.ts#getPlacementOverview`]: {
    scope: "college",
    roles: ["director", "admin"],
    uniform: "companies, drives, applications and profiles are read college-wide by both roles",
    policies: ["companies_read", "placement_drives_read_staff", "placement_applications_read_staff", "profiles_read_staff_same_college"],
  },
  [`${P}director/placements/actions.ts#listPlacements`]: {
    scope: "college",
    roles: ["director", "admin"],
    uniform: "placements, students and profiles are read college-wide by both roles",
    policies: ["placements_read_staff", "students_read_staff", "profiles_read_staff_same_college"],
  },
  [`${P}director/placements/funnel/actions.ts#getInstitutionPlacementFunnel`]: { scope: "college", roles: ["director"] },
  [`${P}finance/dashboard/page.tsx#FinanceDashboard`]: {
    scope: "college",
    roles: "route",
    uniform: "fees, payments and profiles read college-wide by finance and admin (admin may open any route)",
    policies: ["fees_read_staff", "payments_finance_manage", "profiles_read_staff_same_college"],
  },
  [`${P}finance/disputes/actions.ts#listFinancialDisputes`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "disputes, students and profiles read college-wide by both roles",
    policies: ["dispute_staff_manage", "students_read_staff", "profiles_read_staff_same_college"],
  },
  [`${P}finance/exceptions/actions.ts#getFinanceExceptions`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "fees, payments, refunds, disputes, students and profiles read college-wide by both roles",
    policies: ["fees_read_staff", "payments_finance_manage", "refund_staff_manage", "dispute_staff_manage", "students_read_staff"],
  },
  [`${P}finance/invoices/actions.ts#listInvoices`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "fees, students and profiles read college-wide by both roles",
    policies: ["fees_read_staff", "students_read_staff", "profiles_read_staff_same_college"],
  },
  [`${P}finance/refunds/actions.ts#listRefundRequests`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "refund_requests read college-wide by both roles",
    policies: ["refund_staff_manage"],
  },
  [`${P}finance/reports/page.tsx#FinanceReports`]: {
    scope: "college",
    roles: "route",
    uniform: "mv_fee_summary filtered by college_id; fees, students, departments read college-wide by finance and admin",
    policies: ["fees_read_staff", "students_read_staff", "departments_read"],
  },
  [`${P}finance/scholarships/actions.ts#listScholarships`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "scholarships, students and profiles read college-wide by both roles",
    policies: ["scholarships_read_staff", "students_read_staff", "profiles_read_staff_same_college"],
  },
  [`${P}finance/transactions/actions.ts#listPayments`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "payments, students and profiles read college-wide by both roles",
    policies: ["payments_finance_manage", "students_read_staff", "profiles_read_staff_same_college"],
  },
  [`${P}finance/transactions/actions.ts#getFeeStats`]: {
    scope: "college",
    roles: ["finance", "admin"],
    uniform: "fees read college-wide by both roles",
    policies: ["fees_read_staff"],
  },
  [`${P}hod/approvals/actions.ts#listHodApprovals`]: { scope: "user", roles: ["hod"] },
  [`${P}hod/approvals/actions.ts#listCorrectionApprovals`]: { scope: "user", roles: ["hod", "admin"] },
  [`${P}hod/dashboard/page.tsx#HodDashboard`]: { scope: "department", roles: "route" },
  [`${P}hod/faculty/actions.ts#listDepartmentFacultyWorkload`]: { scope: "split", roles: ["director", "hod"] },
  [`${P}hod/reports/page.tsx#HodReports`]: { scope: "department", roles: "route" },
  [`${P}hod/substitutions/actions.ts#listSubstitutionNeeds`]: { scope: "user", roles: ["hod", "admin"] },
  [`${P}placement-cell/companies/actions.ts#listCompanies`]: {
    scope: "college",
    roles: ["placement_cell", "director", "admin"],
    uniform: "companies are readable college-wide by every role",
    policies: ["companies_read"],
  },
  [`${P}placement-cell/dashboard/actions.ts#getPlacementCellDashboard`]: { scope: "role", roles: ["placement_cell", "director", "admin"] },
  [`${P}placement-cell/drives/actions.ts#listDrives`]: {
    scope: "college",
    roles: ["placement_cell", "director", "admin"],
    uniform: "placement_drives, companies and placement_applications read college-wide by all three roles",
    policies: ["placement_drives_read_staff", "companies_read", "placement_applications_read_staff"],
  },
  [`${P}placement-cell/records/actions.ts#listStudentPlacementRecords`]: { scope: "role", roles: ["placement_cell", "director", "admin"] },
  [`${P}placement-cell/reports/actions.ts#getPlacementReports`]: { scope: "role", roles: ["placement_cell", "director", "admin"] },
  [`${P}super-admin/colleges/actions.ts#listColleges`]: { scope: "platform", roles: ["super_admin"] },
  [`${P}warden/complaints/actions.ts#listHostelComplaints`]: { scope: "split", roles: ["warden", "admin"] },
  [`${P}warden/dashboard/page.tsx#WardenDashboard`]: { scope: "user", roles: "route" },
  [`${P}warden/gatepasses/actions.ts#listPendingGatePasses`]: { scope: "split", roles: ["warden", "admin"] },
  [`${P}warden/gatepasses/actions.ts#listProcessedGatePasses`]: { scope: "split", roles: ["warden", "admin"] },
  [`${P}warden/gatepasses/actions.ts#getGateOperationsSnapshot`]: { scope: "split", roles: ["warden", "admin"] },
  [`${P}warden/rooms/actions.ts#listWardenRooms`]: { scope: "split", roles: ["warden", "admin"] },
  [`${P}warden/transfers/actions.ts#listRoomTransferRequests`]: { scope: "split", roles: ["warden", "admin"] },
  ["lib/supabase/middleware.ts#updateSession"]: { scope: "user", roles: "route" },
};

// ---------------------------------------------------------------------------

interface Site {
  id: string;
  roleArg: string;
  body: string;
  file: string;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

function cachedReadSites(): Site[] {
  const sites: Site[] = [];
  for (const full of [...sourceFiles("app"), ...sourceFiles("lib")]) {
    const file = full.split(String.fromCharCode(92)).join("/");
    if (file === "lib/cache.ts") continue;
    const src = readFileSync(full, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!line.includes("getCached(") || t.startsWith("*") || t.startsWith("//")) return;
      let fn = "?";
      let fnLine = 0;
      for (let j = i; j >= 0; j--) {
        const m = lines[j].match(/^export (?:default )?async function (\w+)|^async function (\w+)/);
        if (m) {
          fn = m[1] ?? m[2];
          fnLine = j;
          break;
        }
      }
      let roleArg = "";
      for (let j = i; j >= Math.max(fnLine, i - 60); j--) {
        const r = lines[j].match(/requireRole\(([^)]*)\)/);
        if (r) {
          roleArg = r[1];
          break;
        }
      }
      sites.push({ id: `${file}#${fn}`, roleArg, body: lines.slice(fnLine, i + 6).join("\n"), file: src });
    });
  }
  return sites;
}

function resolveRoles(site: Site): string[] | "route" {
  const arg = site.roleArg.trim();
  if (!arg) return "route";
  const perm = arg.match(/^PERMISSIONS\.(\w+)$/);
  if (perm) return [...(PERMISSIONS as Record<string, readonly string[]>)[perm[1]]];
  const literal = arg.match(/^\[([^\]]*)\]/);
  if (literal) return [...literal[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const constant = site.file.match(new RegExp(`const ${arg} = \\[([^\\]]*)\\]`));
  if (constant) return [...constant[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  throw new Error(`${site.id}: cannot resolve requireRole(${arg})`);
}

const sites = cachedReadSites();
const migrations = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join("supabase/migrations", f), "utf8"))
  .join("\n");

describe("every cached read declares its visibility scope", () => {
  it("finds the cached reads at all (guards the scan)", () => {
    expect(sites.length).toBeGreaterThan(40);
  });

  it("has a registry entry for every cached read, and none for a read that no longer exists", () => {
    const found = new Set(sites.map((s) => s.id));
    const missing = [...found].filter((id) => !(id in REGISTRY));
    const stale = Object.keys(REGISTRY).filter((id) => !found.has(id));
    expect(missing, `declare the cache scope of: ${missing.join(", ")}`).toEqual([]);
    expect(stale, `registry entries with no cached read: ${stale.join(", ")}`).toEqual([]);
  });

  it.each(sites.map((s) => [s.id, s] as const))("%s: the roles that can reach it are the declared ones", (id, site) => {
    const declared = REGISTRY[id].roles;
    const actual = resolveRoles(site);
    if (declared === "route" || actual === "route") {
      expect(actual, `${id}: guarded by requireRole now — list its roles`).toBe(declared);
      return;
    }
    expect([...actual].sort(), `${id}: its roles changed — re-prove its cache scope`).toEqual([...declared].sort());
  });

  it.each(sites.map((s) => [s.id, s] as const))("%s: the key encodes the declared scope", (id, site) => {
    const { scope } = REGISTRY[id];
    if (scope === "role") expect(site.body, `${id}: a role-scoped read must key on actor.role`).toMatch(/actor\.role\}/);
    if (scope === "split") expect(site.body, `${id}: a split read must key admin/director on the college and the narrower role on the user`).toMatch(/actor\.role === "(admin|hod)" \?/);
    if (scope === "user") expect(site.body).toMatch(/actor\.userId|user\.id/);
    if (scope === "platform") expect(site.body).toMatch(/"platform"/);
  });

  it("every multi-role college-scoped read cites why its roles see the same rows", () => {
    for (const [id, entry] of Object.entries(REGISTRY)) {
      // A route page is reachable by its route's role AND by admin (the
      // middleware lets admin open any route) — except /admin/ pages, which
      // only admin reaches.
      const multi = entry.roles === "route" ? !id.includes(`${P}admin/`) : entry.roles.length > 1;
      if (entry.scope === "college" && multi) {
        expect(entry.uniform, `${id}: multi-role college scope needs a proof`).toBeTruthy();
      }
      for (const policy of entry.policies ?? []) {
        expect(migrations, `${id} cites RLS policy ${policy}, which no migration creates`).toContain(`CREATE POLICY "${policy}"`);
      }
    }
  });
});
