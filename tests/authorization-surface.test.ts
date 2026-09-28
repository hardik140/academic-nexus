import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PERMISSIONS, can, type Permission } from "@/lib/permissions";

/**
 * §13 — permission centralization, as a property rather than a refactor.
 *
 * §13 asks for authorization to be centralized and says, in the same breath,
 * *"Do NOT blindly replace everything. Classify each authorization rule."*
 * Classifying the 218 gate call sites in this repository gives an answer that
 * a mechanical sweep would have destroyed:
 *
 *   - 130 already resolve through the named PERMISSIONS table. These are the
 *     rules that are CAPABILITIES — assign_hod, approve_refund, the gate
 *     security set, the escalation set. They are shared across call sites and
 *     the UI asks the same table via can(), so naming them buys something.
 *   - 88 are portal-SECTION role gates: requireRole(["director"]) inside
 *     /director, requireRole(["admin"]) inside /admin. Here the role IS the
 *     rule. Renaming ["admin"] to PERMISSIONS.admin_only would add a layer of
 *     indirection and no meaning, and §13 warns against exactly that
 *     ("Do not create a giant generic function that hides important business
 *     logic. Authorization should remain readable and testable.")
 *
 * So this file does not assert that the 88 were rewritten. It asserts the
 * three things that actually protect the authorization surface:
 *
 *   1. Nothing mutates without passing through a gate.
 *   2. The permission table does not contain rules that control nothing.
 *   3. The surface itself is pinned, so widening any gate is a visible diff
 *      in review rather than a one-word edit nobody sees.
 *
 * Note on depth: these are STATIC properties of the source. They are worth
 * having because they hold for every call site at once, but the real
 * authorization boundary is the database — RLS, the tenant guards and the
 * triggers in 047/050/051/052 — and that is where the adversarial suites
 * prove it. A gate is defence in depth on top of that, which is why a missing
 * one is a defect worth failing a build over rather than a breach.
 */

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");

/** The call shapes that constitute a central gate. */
const GATE_CALL =
  /(?:requireRoleFromRequest\(\s*[A-Za-z_$][\w$]*\s*,\s*|requireRole\(\s*)(\[[^\]]*\]|PERMISSIONS\.[a-z_0-9]+|[A-Z][A-Z_0-9]*)/g;

/** Anything that establishes authorization, including the non-role kinds. */
const ANY_GATE =
  /requireRole|requireRoleFromRequest|requireSecurityPermission|verifySignatureAppRouter/;

interface Gate {
  file: string;
  section: string | null;
  roles: string[];
  named: string | null;
}

function parsePermissionsTable(): Record<string, string[]> {
  const src = readFileSync(join(ROOT, "lib/permissions.ts"), "utf8");
  const body = src.slice(src.indexOf("export const PERMISSIONS"));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/^\s{2}([a-z_0-9]+):\s*\[([^\]]*)\]/gm)) {
    out[m[1]] = m[2].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return out;
}

function collectGates(): Gate[] {
  const table = parsePermissionsTable();
  const gates: Gate[] = [];

  for (const file of [...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "lib"))]) {
    const r = rel(file);
    if (r === "lib/permissions.ts" || r === "lib/rbac.ts") continue;
    const src = readFileSync(file, "utf8");
    const section = r.startsWith("app/(portal)/") ? r.split("/")[2] : null;

    // A file may route a named entry through a local const:
    //   const ACADEMIC_PERIOD_ROLES = PERMISSIONS.academic_period_manage;
    const viaConst = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Z][A-Z_0-9]*)\s*=\s*PERMISSIONS\.([a-z_0-9]+)/g)) {
      viaConst.set(m[1], m[2]);
    }

    for (const m of src.matchAll(GATE_CALL)) {
      const arg = m[1];
      if (arg.startsWith("[")) {
        const roles = arg
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        // `[...ALL_ROLES]` and friends are already centralized elsewhere.
        if (roles.some((x) => /[^a-z_]/.test(x))) continue;
        gates.push({ file: r, section, roles, named: null });
      } else {
        const key = arg.startsWith("PERMISSIONS.") ? arg.slice("PERMISSIONS.".length) : viaConst.get(arg);
        if (!key) continue;
        gates.push({ file: r, section, roles: table[key] ?? [], named: key });
      }
    }
  }
  return gates;
}

// ---------------------------------------------------------------------------
// 1. Nothing mutates without a gate
// ---------------------------------------------------------------------------

/**
 * Routes that legitimately run before any role exists. Each is
 * pre-authentication by nature: the caller is proving who they are, so there
 * is nobody to authorize yet.
 */
const PRE_AUTH = new Set([
  "app/auth/callback/route.ts",
  "app/auth/confirm/route.ts",
  "app/auth/accept-invite/actions.ts",
  "app/auth/reset-password/actions.ts",
]);

describe("no mutation reaches the database without passing a gate", () => {
  const actionFiles = sourceFiles(join(ROOT, "app")).filter((f) =>
    /(actions|route)\.tsx?$/.test(f)
  );

  it("scans the action surface at all (guards the scanner itself)", () => {
    expect(actionFiles.length).toBeGreaterThan(90);
  });

  it("every exported function is gated, handed an authorized actor, or delegates to one that is", () => {
    const ungated: string[] = [];

    for (const file of actionFiles) {
      const r = rel(file);
      if (PRE_AUTH.has(r)) continue;
      const src = readFileSync(file, "utf8");

      const marks = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)];

      // Functions in this file that ARE gated, so a thin wrapper delegating
      // to one of them counts as covered. This spans ALL top-level functions,
      // not just exported ones: finance/disputes wraps two exported actions
      // around a private finalizeDispute() that holds the gate, and an
      // exported-only scan reported both wrappers as ungated.
      const allFns = [...src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)];
      const gatedHere = new Set<string>();
      for (let i = 0; i < allFns.length; i++) {
        const body = src.slice(allFns[i].index!, allFns[i + 1]?.index ?? src.length);
        if (ANY_GATE.test(body)) gatedHere.add(allFns[i][1]);
      }

      for (let i = 0; i < marks.length; i++) {
        const name = marks[i][1];
        const body = src.slice(marks[i].index!, marks[i + 1]?.index ?? src.length);

        if (ANY_GATE.test(body)) continue;

        // Handed a caller that requireRole already vouched for. Checked on the
        // SIGNATURE, not the name, so calling something "…Core" is not enough.
        if (/actor:\s*AuthorizedActor/.test(body)) continue;

        // A wrapper over a gated sibling, or over a *ViaRequest entry point
        // that carries its own requireRoleFromRequest.
        const delegates = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]);
        if (delegates.some((d) => gatedHere.has(d) || /ViaRequest$/.test(d))) continue;

        // A route handler whose file verifies a QStash signature instead of a
        // session — the cron surface.
        if (/verifySignatureAppRouter/.test(src)) continue;

        ungated.push(`${r} → ${name}`);
      }
    }

    expect(ungated, `ungated exported functions:\n${ungated.join("\n")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The table must not contain rules that control nothing
// ---------------------------------------------------------------------------

/**
 * Named, and deliberately not enforced yet. A permission entry with no call
 * site is worse than no entry: a reader who edits it believes they have
 * changed who can do something, and nothing changes. These two are recorded
 * here rather than deleted because they describe intended capabilities; if
 * they are still here when their features are not, delete them.
 */
const NOT_YET_ENFORCED = new Set<Permission>([
  // No resolve action exists — acknowledge and act do. See
  // app/(portal)/director/attention/actions.ts.
  "escalation_resolve",
  // The director analytics reads gate on institution_health_read and
  // institution_placement_funnel_read; nothing reads this one.
  "institution_analytics_read",
]);

describe("the permission table describes rules that actually run", () => {
  it("has no entry that nothing references", () => {
    const used = new Set(collectGates().map((g) => g.named).filter(Boolean) as string[]);
    const dead = (Object.keys(PERMISSIONS) as Permission[])
      .filter((k) => !used.has(k) && !NOT_YET_ENFORCED.has(k));
    expect(dead, `permission entries that control nothing: ${dead.join(", ")}`).toEqual([]);
  });

  it("does not let the not-yet-enforced list quietly grow", () => {
    expect(NOT_YET_ENFORCED.size).toBe(2);
  });

  it("gives every entry at least one role", () => {
    for (const [name, roles] of Object.entries(PERMISSIONS)) {
      expect((roles as readonly string[]).length, `${name} grants nobody`).toBeGreaterThan(0);
    }
  });

  it("the UI asks the same table the server enforces", () => {
    // can() is what decides whether a button is rendered; requireRole is what
    // decides whether the action runs. They must not be two lists.
    // PERMISSIONS entries are `readonly` tuples, so the element type has to
    // be readonly too — a mutable string[] does not accept them.
    for (const [name, roles] of Object.entries(PERMISSIONS) as [Permission, readonly string[]][]) {
      for (const role of roles) {
        expect(can(role as never, name), `${role} should pass can(${name})`).toBe(true);
      }
      expect(can("student" as never, name)).toBe(roles.includes("student"));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The surface is pinned
// ---------------------------------------------------------------------------

/**
 * Every distinct set of roles that can pass a gate, per portal section.
 *
 * This is the whole authorization surface of the web app in 30 lines. It is
 * pinned so that WIDENING a gate — adding "admin" to a warden-only action,
 * say — cannot happen as a silent one-word edit: it changes this list and has
 * to be justified in review. Narrowing shows up here too.
 *
 * Adding a genuinely new capability means adding its entry here, on purpose.
 */
const SURFACE: Record<string, string[]> = {
  // "admin+director" is academic_period_manage, reached through a local
  // const (ACADEMIC_PERIOD_ROLES) rather than named at the call site — which
  // is why the scanner above resolves that indirection instead of only
  // matching `PERMISSIONS.x` inline.
  admin: ["admin", "admin+director", "admin+director+hod"],
  director: [
    "admin+director",
    "admin+director+warden",
    "director",
    "director+hod",
    "hod+placement_cell+teacher+warden",
    "hod+placement_cell+warden",
  ],
  finance: ["admin", "admin+finance"],
  hod: ["admin+hod", "director+hod", "hod"],
  "placement-cell": ["admin+director+placement_cell", "admin+placement_cell"],
  security: ["gate_security"],
  student: ["student"],
  "super-admin": ["super_admin"],
  teacher: ["admin+hod+teacher", "admin+teacher", "teacher"],
  warden: ["admin+director+warden", "admin+warden"],
};

describe("the authorization surface is pinned", () => {
  const actual = () => {
    const m: Record<string, Set<string>> = {};
    for (const g of collectGates()) {
      if (!g.section) continue;
      (m[g.section] ||= new Set()).add([...g.roles].sort().join("+"));
    }
    return Object.fromEntries(
      Object.entries(m).sort().map(([k, v]) => [k, [...v].sort()])
    );
  };

  it("found a surface at all", () => {
    const gates = collectGates();
    expect(gates.length).toBeGreaterThan(200);
    expect(gates.filter((g) => g.named).length).toBeGreaterThan(100);
  });

  it("matches, section for section", () => {
    expect(actual()).toEqual(SURFACE);
  });

  it("grants no role outside the known set", () => {
    const KNOWN = new Set([
      "student", "teacher", "hod", "finance", "director",
      "admin", "warden", "super_admin", "placement_cell", "gate_security",
    ]);
    for (const g of collectGates()) {
      for (const role of g.roles) {
        expect(KNOWN.has(role), `${g.file} gates on unknown role "${role}"`).toBe(true);
      }
    }
  });
});
