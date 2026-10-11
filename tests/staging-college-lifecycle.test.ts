import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  stagingDb, as, asSession, verify, scalar, U, S, COLLEGE_A, COLLEGE_B, FEE_A, GATE_MAIN,
} from "./staging/harness";

/**
 * Migrations 053 and 054 — college lifecycle and the session registry —
 * against the repository's real migration chain on disposable PostgreSQL.
 *
 * Every attempt runs as `authenticated` with the caller's claims, the way a
 * PostgREST request arrives (see harness.as/asSession), so these are the
 * outcomes a browser, the mobile app or a hand-crafted API call would get
 * when it reaches the database directly. What this does NOT exercise:
 * GoTrue itself (token issue, refresh, expiry) — reported as UNVERIFIED.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const fresh = () => stagingDb();

const PLATFORM = "00000000-0000-0000-0000-000000000000";
const REASON = "Scheduled database maintenance window";

/** Deterministic GoTrue-shaped session ids. */
const sid = (n: number) => `5e550000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function lifecycle(d: PGlite, actor: string, college: string, state: string, opts: { reason?: string; message?: string | null; resume?: string | null } = {}) {
  return asSession(d, actor, null,
    `SELECT lifecycle_state, lifecycle_message, lifecycle_expected_resume_at FROM public.set_college_lifecycle($1,$2,$3,$4,$5)`,
    [college, state, opts.reason ?? REASON, opts.message ?? null, opts.resume ?? null]);
}

function register(d: PGlite, uid: string, session: string | null, client = "web", deviceId: string | null = null) {
  return asSession(d, uid, session,
    `SELECT public.register_current_session($1, $2, 'QA device', 'vitest') AS r`, [client, deviceId])
    .then((a) => ({ ...a, state: (a.data[0]?.r as { state?: string } | undefined)?.state ?? null, r: a.data[0]?.r as Record<string, unknown> | undefined }));
}

const sessionStatus = (d: PGlite, session: string) =>
  scalar(d, `SELECT status FROM user_sessions WHERE session_id=$1`, [session]);

/**
 * Every row of every college-scoped table, hashed per table. The lifecycle
 * tables themselves, the audit log and the session registry are expected to
 * change; nothing else may.
 */
async function fingerprint(d: PGlite, college: string): Promise<Record<string, string>> {
  const tables = await verify<{ table_name: string }>(d,
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'college_id' AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT IN ('audit_logs', 'user_sessions', 'college_lifecycle_events')
      ORDER BY c.table_name`);
  const out: Record<string, string> = {};
  for (const { table_name } of tables) {
    out[table_name] = String(await scalar(d,
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) || ':' || count(*) FROM public.${table_name} t WHERE college_id = $1`,
      [college]));
  }
  out.colleges_non_lifecycle = String(await scalar(d,
    `SELECT md5((to_jsonb(c) - 'lifecycle_state' - 'lifecycle_message' - 'lifecycle_expected_resume_at' - 'lifecycle_changed_at' - 'lifecycle_changed_by' - 'updated_at')::text) FROM colleges c WHERE id = $1`,
    [college]));
  return out;
}

// ─────────────────────────────────────────────────────────────
// Migration state
// ─────────────────────────────────────────────────────────────
describe("after migration", () => {
  it("every existing college is ACTIVE with no outage detail, and the Platform college is pinned ACTIVE", async () => {
    const rows = await verify<{ lifecycle_state: string; lifecycle_message: string | null; is_platform: boolean }>(db,
      `SELECT lifecycle_state, lifecycle_message, is_platform FROM colleges`);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.lifecycle_state === "ACTIVE" && r.lifecycle_message === null)).toBe(true);
    await expect(verify(db, `UPDATE colleges SET lifecycle_state='SUSPENDED' WHERE id=$1`, [PLATFORM]))
      .rejects.toThrow(/colleges_platform_always_active/);
  });

  it("session enforcement starts in 'register' mode and the approved per-role limits are configured", async () => {
    expect(await scalar(db, `SELECT value FROM platform_settings WHERE key='session_enforcement'`)).toBe("register");
    const limits = await verify<{ role: string; max_sessions: number | null }>(db,
      `SELECT role, max_sessions FROM role_session_limits ORDER BY role`);
    expect(Object.fromEntries(limits.map((l) => [l.role, l.max_sessions]))).toEqual({
      admin: 2, director: 2, finance: 2, gate_security: 2, hod: 2, parent: 1,
      placement_cell: 2, student: 1, super_admin: null, teacher: 2, warden: 2,
    });
  });

  it("every role a profile may hold has a configured limit (a role without one is admitted nowhere)", async () => {
    const def = String(await scalar(db,
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.profiles'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%super_admin%'`));
    const roles = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    const limited = (await verify<{ role: string }>(db, `SELECT role FROM role_session_limits ORDER BY role`)).map((r) => r.role);
    expect(roles.length).toBeGreaterThanOrEqual(11);
    expect(limited).toEqual(roles);
  });

  it("every RLS table carries the restrictive tenant_access_gate, and every RLS table but user_sessions the write gate", async () => {
    const missingGate = await verify<{ relname: string }>(db,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname
                          AND p.policyname LIKE 'tenant_access_gate%' AND p.permissive='RESTRICTIVE')`);
    expect(missingGate.map((r) => r.relname)).toEqual([]);
    const missingTrigger = await verify<{ relname: string }>(db,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relname <> 'user_sessions'
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='guard_tenant_write_access')`);
    expect(missingTrigger.map((r) => r.relname)).toEqual([]);
    const tables = Number(await scalar(db,
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity`));
    expect(tables).toBeGreaterThanOrEqual(68);
  });
});

// ─────────────────────────────────────────────────────────────
// Transitions — who, and which
// ─────────────────────────────────────────────────────────────
describe("set_college_lifecycle()", () => {
  it("lets super_admin make every transition between the three states", async () => {
    const d = await fresh();
    try {
      const path = ["MAINTENANCE", "ACTIVE", "SUSPENDED", "ACTIVE", "MAINTENANCE", "SUSPENDED", "MAINTENANCE", "ACTIVE"];
      for (const state of path) {
        const r = await lifecycle(d, U.superAdmin, COLLEGE_A, state);
        expect(r.ok, `${state}: ${r.error}`).toBe(true);
        expect(r.data[0].lifecycle_state).toBe(state);
      }
      const history = await verify<{ previous_state: string; new_state: string }>(d,
        `SELECT previous_state, new_state FROM college_lifecycle_events WHERE college_id=$1 ORDER BY changed_at, id`, [COLLEGE_A]);
      expect(history.map((h) => `${h.previous_state}>${h.new_state}`)).toEqual([
        "ACTIVE>MAINTENANCE", "MAINTENANCE>ACTIVE", "ACTIVE>SUSPENDED", "SUSPENDED>ACTIVE",
        "ACTIVE>MAINTENANCE", "MAINTENANCE>SUSPENDED", "SUSPENDED>MAINTENANCE", "MAINTENANCE>ACTIVE",
      ]);
    } finally { await d.close(); }
  });

  it("publishes a maintenance message and expected resume time, and lets them be updated while blocked", async () => {
    const d = await fresh();
    try {
      const resume = new Date(Date.now() + 3 * 3600_000).toISOString();
      const r = await lifecycle(d, U.superAdmin, COLLEGE_A, "MAINTENANCE", { message: "Upgrading the results module.", resume });
      expect(r.ok, r.error ?? "").toBe(true);
      expect(r.data[0].lifecycle_message).toBe("Upgrading the results module.");

      const later = new Date(Date.now() + 5 * 3600_000).toISOString();
      const upd = await lifecycle(d, U.superAdmin, COLLEGE_A, "MAINTENANCE", { message: "Upgrading the results module.", resume: later });
      expect(upd.ok, upd.error ?? "").toBe(true);

      const back = await lifecycle(d, U.superAdmin, COLLEGE_A, "ACTIVE");
      expect(back.data[0]).toMatchObject({ lifecycle_state: "ACTIVE", lifecycle_message: null, lifecycle_expected_resume_at: null });
    } finally { await d.close(); }
  });

  it.each([
    ["no change", "ACTIVE", {}, /already ACTIVE/],
    ["a short reason", "MAINTENANCE", { reason: "because" }, /reason of 10/],
    ["an unknown state", "ARCHIVED", {}, /must be ACTIVE, MAINTENANCE or SUSPENDED/],
    ["a resume time on SUSPENDED", "SUSPENDED", { resume: new Date(Date.now() + 3600_000).toISOString() }, /applies only to MAINTENANCE/],
    ["a resume time in the past", "MAINTENANCE", { resume: new Date(Date.now() - 3600_000).toISOString() }, /must be in the future/],
    ["an outage message on ACTIVE", "ACTIVE", { message: "hello" }, /no outage message/],
  ])("refuses %s", async (_label, state, opts, error) => {
    const r = await lifecycle(db, U.superAdmin, COLLEGE_A, state as string, opts as never);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(error as RegExp);
  });

  it("refuses the Platform college and an unknown college", async () => {
    expect((await lifecycle(db, U.superAdmin, PLATFORM, "MAINTENANCE")).error).toMatch(/platform college is always ACTIVE/);
    expect((await lifecycle(db, U.superAdmin, "00000001-0000-4000-8000-0000000000ff", "MAINTENANCE")).error).toMatch(/no such college/);
  });

  // Adversarial 1, 2, 3: a College Admin — or anyone but super_admin — through every door.
  it.each([
    ["the College Admin", U.admin],
    ["the Director", U.director],
    ["a student", U.studentA],
  ])("refuses %s, through the function", async (_label, actor) => {
    const r = await lifecycle(db, actor, COLLEGE_A, "SUSPENDED");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only a super admin/);
  });

  it("refuses the College Admin's direct UPDATE of its own college's lifecycle (016's write policy), loudly", async () => {
    const d = await fresh();
    try {
      for (const set of [
        "lifecycle_state='SUSPENDED'",
        "lifecycle_message='down'",
        "lifecycle_changed_by=auth.uid()",
      ]) {
        const r = await as(d, U.admin, `UPDATE public.colleges SET ${set} WHERE id='${COLLEGE_A}'`);
        expect(r.ok, set).toBe(false);
        expect(r.error).toMatch(/only be changed through set_college_lifecycle/);
      }
      // ...while ordinary profile edits through 016 still work.
      const ok = await as(d, U.admin, `UPDATE public.colleges SET phone='0000' WHERE id='${COLLEGE_A}'`);
      expect(ok.rows, ok.error ?? "").toBe(1);
      expect(await scalar(d, `SELECT lifecycle_state FROM colleges WHERE id=$1`, [COLLEGE_A])).toBe("ACTIVE");
    } finally { await d.close(); }
  });

  it("refuses the College Admin's UPDATE of ANOTHER college: RLS matches nothing", async () => {
    const r = await as(db, U.admin, `UPDATE public.colleges SET lifecycle_state='SUSPENDED' WHERE id='${COLLEGE_B}'`);
    expect(r.rows).toBe(0);
    expect(await scalar(db, `SELECT lifecycle_state FROM colleges WHERE id=$1`, [COLLEGE_B])).toBe("ACTIVE");
  });

  it("refuses even super_admin's direct UPDATE — the reason and the audit trail are not optional", async () => {
    const r = await as(db, U.superAdmin, `UPDATE public.colleges SET lifecycle_state='SUSPENDED' WHERE id='${COLLEGE_A}'`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only be changed through set_college_lifecycle/);
  });

  it("refuses a new college that does not start ACTIVE", async () => {
    const r = await as(db, U.superAdmin,
      `INSERT INTO public.colleges (name, code, lifecycle_state) VALUES ('Z','ZZ-1','SUSPENDED')`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/starts ACTIVE/);
  });

  it("is not executable by anon at all", async () => {
    await db.exec(`SET ROLE anon`);
    try {
      await expect(db.query(`SELECT public.set_college_lifecycle('${COLLEGE_A}','SUSPENDED','${REASON}')`)).rejects.toThrow(/permission denied/);
    } finally { await db.exec(`RESET ROLE`); }
  });
});

// ─────────────────────────────────────────────────────────────
// History and audit — adversarial 20
// ─────────────────────────────────────────────────────────────
describe("lifecycle history and audit", () => {
  it("records who, which college, previous and new state, when, why, the published message and the sessions revoked", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      await register(d, U.teacherA, sid(2));
      const resume = new Date(Date.now() + 7200_000).toISOString();
      await lifecycle(d, U.superAdmin, COLLEGE_A, "MAINTENANCE", { message: "Exam portal upgrade", resume });

      const [h] = await verify<Record<string, unknown>>(d,
        `SELECT college_id, previous_state, new_state, changed_by, reason, message, expected_resume_at, sessions_revoked, changed_at
           FROM college_lifecycle_events WHERE college_id=$1`, [COLLEGE_A]);
      expect(h).toMatchObject({
        college_id: COLLEGE_A, previous_state: "ACTIVE", new_state: "MAINTENANCE", changed_by: U.superAdmin,
        reason: REASON, message: "Exam portal upgrade", sessions_revoked: 2,
      });
      expect(h.changed_at).toBeTruthy();

      const [a] = await verify<Record<string, unknown>>(d,
        `SELECT college_id, user_id, action, old_value, new_value FROM audit_logs WHERE action='college.lifecycle_changed'`);
      expect(a).toMatchObject({ college_id: COLLEGE_A, user_id: U.superAdmin });
      expect(a.old_value).toEqual({ lifecycle_state: "ACTIVE" });
      expect(a.new_value).toMatchObject({ lifecycle_state: "MAINTENANCE", reason: REASON, sessions_revoked: 2 });
    } finally { await d.close(); }
  });

  it("is readable by super_admin only — not the College Admin, not a student, not another college", async () => {
    const d = await fresh();
    try {
      await lifecycle(d, U.superAdmin, COLLEGE_B, "SUSPENDED");
      expect((await as(d, U.superAdmin, `SELECT id FROM public.college_lifecycle_events`)).data).toHaveLength(1);
      for (const u of [U.admin, U.director, U.studentA, U.bHod]) {
        expect((await as(d, u, `SELECT id FROM public.college_lifecycle_events`)).data, u).toHaveLength(0);
      }
    } finally { await d.close(); }
  });

  it("cannot be changed or removed — by super_admin, by direct write, or by a forged insert", async () => {
    const d = await fresh();
    try {
      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
      const id = String(await scalar(d, `SELECT id FROM college_lifecycle_events LIMIT 1`));
      for (const sql of [
        `UPDATE public.college_lifecycle_events SET reason='nothing happened here' WHERE id='${id}'`,
        `DELETE FROM public.college_lifecycle_events WHERE id='${id}'`,
        `INSERT INTO public.college_lifecycle_events (college_id, previous_state, new_state, reason, changed_by) VALUES ('${COLLEGE_A}','ACTIVE','ACTIVE','a forged history row',auth.uid())`,
      ]) {
        const r = await as(d, U.superAdmin, sql);
        expect(r.ok, sql).toBe(false);
        expect(r.error).toMatch(/permission denied/);
      }
      // The audit_logs row is immutable too (052's guard).
      const auditUpdate = await as(d, U.superAdmin, `UPDATE public.audit_logs SET action='x' WHERE action='college.lifecycle_changed'`);
      expect(auditUpdate.rows === 0 || auditUpdate.ok === false).toBe(true);
      expect(await scalar(d, `SELECT count(*)::int FROM audit_logs WHERE action='college.lifecycle_changed'`)).toBe(1);
      expect(await scalar(d, `SELECT reason FROM college_lifecycle_events WHERE id=$1`, [id])).toBe(REASON);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// The full block — adversarial 4, 5, 6, 14, 15 (DB side), 16
// ─────────────────────────────────────────────────────────────
describe.each(["MAINTENANCE", "SUSPENDED"])("a college in %s", (state) => {
  let d: PGlite;
  beforeAll(async () => {
    d = await fresh();
    const r = await lifecycle(d, U.superAdmin, COLLEGE_A, state);
    expect(r.ok, r.error ?? "").toBe(true);
  });
  afterAll(async () => { await d?.close(); });

  it("is closed to every one of its users: no operational role, no operational college", async () => {
    for (const u of [U.studentA, U.teacherA, U.hodCse, U.finance, U.warden, U.director, U.admin, U.guardMain]) {
      const r = await as(d, u, `SELECT public.my_operational_college_id() AS c, public.my_operational_role() AS r, public.app_access_allowed() AS ok`);
      expect(r.data[0], u).toEqual({ c: null, r: null, ok: false });
    }
  });

  it("returns nothing through the policies that check only auth.uid() — a student's own fees, record, enrolments and notifications", async () => {
    for (const sql of [
      `SELECT id FROM public.fees WHERE id='${FEE_A}'`,
      `SELECT id FROM public.students WHERE user_id=auth.uid()`,
      `SELECT * FROM public.course_enrollments`,
      `SELECT * FROM public.notifications`,
      `SELECT * FROM public.marks`,
      `SELECT * FROM public.attendance`,
    ]) {
      const r = await as(d, U.studentA, sql);
      expect(r.ok, `${sql}: ${r.error}`).toBe(true);
      expect(r.data, sql).toHaveLength(0);
    }
    // The control case: the same reads succeed for the same kind of user in College B.
    expect((await as(d, U.bStudent, `SELECT id FROM public.students WHERE user_id=auth.uid()`)).data).toHaveLength(1);
  });

  it("returns nothing to staff, including the College Admin and the Director", async () => {
    for (const [u, sql] of [
      [U.admin, `SELECT id FROM public.profiles WHERE id <> auth.uid()`],
      [U.admin, `SELECT id FROM public.departments`],
      [U.director, `SELECT id FROM public.course_offerings`],
      [U.teacherA, `SELECT id FROM public.course_offerings`],
      [U.finance, `SELECT id FROM public.fees`],
      [U.warden, `SELECT id FROM public.gate_passes`],
      [U.admin, `SELECT id FROM public.colleges`],
    ] as const) {
      expect((await as(d, u, sql)).data, `${u}: ${sql}`).toHaveLength(0);
    }
  });

  it("still lets each user read their OWN profile row (routing and the maintenance page) and nothing else of profiles", async () => {
    const r = await as(d, U.studentA, `SELECT id FROM public.profiles`);
    expect(r.data.map((x) => x.id)).toEqual([U.studentA]);
  });

  it("refuses every write, loudly", async () => {
    for (const [u, sql] of [
      [U.studentA, `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time) VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now(), now() + interval '2 hours')`],
      [U.studentA, `UPDATE public.profiles SET phone='1' WHERE id=auth.uid()`],
      [U.admin, `UPDATE public.colleges SET phone='1' WHERE id='${COLLEGE_A}'`],
      [U.admin, `INSERT INTO public.departments (college_id, name, code) VALUES ('${COLLEGE_A}','X','X1')`],
      [U.teacherA, `INSERT INTO public.notifications (user_id, college_id, title, message) VALUES (auth.uid(),'${COLLEGE_A}','t','m')`],
    ] as const) {
      const r = await as(d, u, sql);
      expect(r.ok, `${u}: ${sql}`).toBe(false);
    }
  });

  it("refuses the SECURITY DEFINER paths that bypass RLS: reopen, manual gate movement, a guard's feed, a student's QR credential", async () => {
    const reopen = await as(d, U.admin, `SELECT public.reopen_semester('00000006-0000-4000-8000-000000000009','reopening for a correction')`);
    expect(reopen.ok).toBe(false);

    const pass = String(await scalar(d, `SELECT id FROM gate_passes WHERE college_id=$1 LIMIT 1`, [COLLEGE_A]));
    const manual = await as(d, U.warden,
      `SELECT outcome FROM public.record_manual_gate_movement('${pass}','OUT','${GATE_MAIN}','phone battery dead at main gate')`);
    expect(manual.ok && manual.data[0]?.outcome === "RECORDED").toBe(false);

    expect((await as(d, U.guardMain, `SELECT public.security_has_permission('gate_security.movement.view') AS v`)).data[0].v).toBe(false);
    expect((await as(d, U.guardMain, `SELECT public.my_security_personnel_id() AS v`)).data[0].v).toBeNull();
    expect((await as(d, U.studentA, `SELECT * FROM public.my_gate_pass_credential('${pass}')`)).data).toHaveLength(0);
  });

  it("does not affect another college — adversarial 14", async () => {
    expect((await as(d, U.bStudent, `SELECT public.my_operational_college_id() AS c`)).data[0].c).toBe(COLLEGE_B);
    expect((await as(d, U.bTeacher, `SELECT id FROM public.course_offerings`)).data.length).toBeGreaterThan(0);
  });

  it("does not block super_admin, and gives it no access it did not already have — adversarial 13", async () => {
    expect((await as(d, U.superAdmin, `SELECT public.app_access_allowed() AS ok`)).data[0].ok).toBe(true);
    // Exactly the rows super_admin could read while every college was ACTIVE
    // (db is the untouched baseline) — managing a lifecycle grants nothing.
    for (const t of ["students", "fees", "marks", "attendance", "course_offerings", "profiles", "user_sessions"]) {
      const baseline = (await as(db, U.superAdmin, `SELECT * FROM public.${t}`)).data.length;
      expect((await as(d, U.superAdmin, `SELECT * FROM public.${t}`)).data.length, t).toBe(baseline);
    }
    // ...and none of College B's academic or financial records, as before.
    for (const t of ["students", "fees", "course_offerings"]) {
      expect((await as(d, U.superAdmin, `SELECT * FROM public.${t} WHERE college_id='${COLLEGE_B}'`)).data, t).toHaveLength(0);
    }
  });

  it("tells each user why, through my_access_state(), without exposing the internal reason", async () => {
    const r = await as(d, U.studentA, `SELECT public.my_access_state() AS s`);
    const s = r.data[0].s as Record<string, unknown>;
    expect(s).toMatchObject({ college_state: state, allowed: false, profile_status: "active", role: "student" });
    expect(JSON.stringify(s)).not.toContain(REASON);
  });
});

// ─────────────────────────────────────────────────────────────
// Reactivation — adversarial 19
// ─────────────────────────────────────────────────────────────
describe("reactivation", () => {
  it.each(["MAINTENANCE", "SUSPENDED"])("after %s, restores access and every college-scoped row is byte-for-byte unchanged", async (state) => {
    const d = await fresh();
    try {
      const before = await fingerprint(d, COLLEGE_A);
      const beforeB = await fingerprint(d, COLLEGE_B);
      expect(Object.keys(before).length).toBeGreaterThan(20);

      await lifecycle(d, U.superAdmin, COLLEGE_A, state);
      await lifecycle(d, U.superAdmin, COLLEGE_A, "ACTIVE");

      expect(await fingerprint(d, COLLEGE_A)).toEqual(before);
      expect(await fingerprint(d, COLLEGE_B)).toEqual(beforeB);
      expect((await as(d, U.studentA, `SELECT id FROM public.fees WHERE id='${FEE_A}'`)).data).toHaveLength(1);
      expect((await as(d, U.teacherA, `SELECT public.my_operational_college_id() AS c`)).data[0].c).toBe(COLLEGE_A);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// Session registry — admission and limits (adversarial 9, 11)
// ─────────────────────────────────────────────────────────────
describe("register_current_session()", () => {
  it("admits a student's first session and REJECTS the second — the first stays active, nothing is evicted", async () => {
    const d = await fresh();
    try {
      expect((await register(d, U.studentA, sid(1))).state).toBe("active");
      const second = await register(d, U.studentA, sid(2));
      expect(second.state).toBe("rejected");
      expect(second.r).toMatchObject({ active_sessions: 1, max_sessions: 1 });
      expect(await sessionStatus(d, sid(1))).toBe("active");
      expect(await sessionStatus(d, sid(2))).toBe("rejected");
      // The rejected session reaches nothing; the admitted one is unaffected.
      expect((await asSession(d, U.studentA, sid(2), `SELECT id FROM public.fees WHERE id='${FEE_A}'`)).data).toHaveLength(0);
      expect((await asSession(d, U.studentA, sid(1), `SELECT id FROM public.fees WHERE id='${FEE_A}'`)).data).toHaveLength(1);
      // Audited, once.
      await register(d, U.studentA, sid(2));
      expect(await scalar(d, `SELECT count(*)::int FROM audit_logs WHERE action='session.rejected' AND record_id=$1`, [sid(2)])).toBe(1);
    } finally { await d.close(); }
  });

  it("rejects a teacher's THIRD device and keeps both earlier ones — adversarial 11", async () => {
    const d = await fresh();
    try {
      expect((await register(d, U.teacherA, sid(1))).state).toBe("active");
      expect((await register(d, U.teacherA, sid(2))).state).toBe("active");
      expect((await register(d, U.teacherA, sid(3))).state).toBe("rejected");
      expect([await sessionStatus(d, sid(1)), await sessionStatus(d, sid(2))]).toEqual(["active", "active"]);
    } finally { await d.close(); }
  });

  it.each([
    ["gate_security", U.guardMain, 2],
    ["warden", U.warden, 2],
    ["finance", U.finance, 2],
    ["hod", U.hodCse, 2],
    ["director", U.director, 2],
    ["admin", U.admin, 2],
  ])("applies the %s limit of %#", async (_role, uid, limit) => {
    const d = await fresh();
    try {
      for (let i = 1; i <= limit; i++) expect((await register(d, uid, sid(i))).state).toBe("active");
      expect((await register(d, uid, sid(limit + 1))).state).toBe("rejected");
    } finally { await d.close(); }
  });

  it("applies the legacy parent limit of 1 and the placement_cell limit of 2", async () => {
    const d = await fresh();
    try {
      const parent = "00000003-0000-4000-8000-0000000000a1";
      const placement = "00000003-0000-4000-8000-0000000000a2";
      await d.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${parent}','parent@qa'), ('${placement}','pc@qa');
        INSERT INTO public.profiles (id, college_id, role, full_name, email, status)
        VALUES ('${parent}','${COLLEGE_A}','parent','QA Parent','parent@qa','active'),
               ('${placement}','${COLLEGE_A}','placement_cell','QA Placement','pc@qa','active')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, status = 'active';`);
      expect((await register(d, parent, sid(1))).state).toBe("active");
      expect((await register(d, parent, sid(2))).state).toBe("rejected");
      expect((await register(d, placement, sid(3))).state).toBe("active");
      expect((await register(d, placement, sid(4))).state).toBe("active");
      expect((await register(d, placement, sid(5))).state).toBe("rejected");
    } finally { await d.close(); }
  });

  it("does not let a forged device identifier make room — adversarial 9", async () => {
    const d = await fresh();
    try {
      expect((await register(d, U.studentA, sid(1), "web", "device-AAAA")).state).toBe("active");
      // A second login claiming to be the SAME device is still a second session.
      expect((await register(d, U.studentA, sid(2), "web", "device-AAAA")).state).toBe("rejected");
      expect((await register(d, U.studentA, sid(3), "mobile", "device-AAAA")).state).toBe("rejected");
      expect(await scalar(d, `SELECT count(*)::int FROM user_sessions WHERE user_id=$1 AND status='active'`, [U.studentA])).toBe(1);
    } finally { await d.close(); }
  });

  it("gives super_admin unlimited sessions", async () => {
    const d = await fresh();
    try {
      for (let i = 1; i <= 5; i++) expect((await register(d, U.superAdmin, sid(i))).state).toBe("active");
    } finally { await d.close(); }
  });

  it("admits nobody whose role has no configured limit (fail closed)", async () => {
    const d = await fresh();
    try {
      await d.exec(`DELETE FROM role_session_limits WHERE role='teacher'`);
      expect((await register(d, U.teacherA, sid(1))).state).toBe("rejected");
    } finally { await d.close(); }
  });

  it("will not register anything for a college that is unavailable, an inactive account, or a token with no session claim", async () => {
    const d = await fresh();
    try {
      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
      expect((await register(d, U.studentA, sid(1))).state).toBe("college_unavailable");
      expect((await register(d, U.bStudent, null)).state).toBe("no_session_claim");
      await d.exec(`UPDATE profiles SET status='suspended' WHERE id='${U.bTeacher}'`);
      expect((await register(d, U.bTeacher, sid(2))).state).toBe("inactive");
      expect(await scalar(d, `SELECT count(*)::int FROM user_sessions`)).toBe(0);
    } finally { await d.close(); }
  });

  it("lets a user at the limit revoke one of their own sessions FROM the rejected session, then be admitted", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      expect((await register(d, U.studentA, sid(2))).state).toBe("rejected");

      const listed = await asSession(d, U.studentA, sid(2), `SELECT session_id, status, is_current FROM public.list_my_sessions()`);
      expect(listed.data.map((r) => [r.session_id, r.status, r.is_current]).sort()).toEqual([
        [sid(1), "active", false], [sid(2), "rejected", true],
      ]);

      const revoked = await asSession(d, U.studentA, sid(2), `SELECT public.revoke_session('${sid(1)}') AS r`);
      expect(revoked.ok, revoked.error ?? "").toBe(true);
      expect((await register(d, U.studentA, sid(2))).state).toBe("active");
      expect(await sessionStatus(d, sid(1))).toBe("revoked");
      expect(await scalar(d, `SELECT revoked_reason FROM user_sessions WHERE session_id=$1`, [sid(1)])).toBe("revoked_by_user");
    } finally { await d.close(); }
  });

  it("refuses direct writes to the registry — a session cannot admit, revive or delete itself", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      await register(d, U.studentA, sid(2));
      for (const sql of [
        `INSERT INTO public.user_sessions (session_id, user_id, college_id, status) VALUES ('${sid(9)}', auth.uid(), '${COLLEGE_A}', 'active')`,
        `UPDATE public.user_sessions SET status='active' WHERE session_id='${sid(2)}'`,
        `DELETE FROM public.user_sessions WHERE session_id='${sid(1)}'`,
      ]) {
        const r = await asSession(d, U.studentA, sid(1), sql);
        expect(r.ok, sql).toBe(false);
        expect(r.error).toMatch(/permission denied/);
      }
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// Revocation — adversarial 7, 8, 12, 17, 18
// ─────────────────────────────────────────────────────────────
describe("revocation", () => {
  it("makes a revoked session unusable for every read and write, and it can never be re-admitted — adversarial 8", async () => {
    const d = await fresh();
    try {
      await register(d, U.teacherA, sid(1));
      await register(d, U.teacherA, sid(2));
      await asSession(d, U.teacherA, sid(2), `SELECT public.revoke_session('${sid(1)}')`);

      expect((await asSession(d, U.teacherA, sid(1), `SELECT id FROM public.course_offerings`)).data).toHaveLength(0);
      expect((await asSession(d, U.teacherA, sid(1), `SELECT public.my_operational_college_id() AS c`)).data[0].c).toBeNull();
      expect((await asSession(d, U.teacherA, sid(1),
        `INSERT INTO public.notifications (user_id, college_id, title, message) VALUES (auth.uid(),'${COLLEGE_A}','t','m')`)).ok).toBe(false);
      expect((await register(d, U.teacherA, sid(1))).state).toBe("revoked");
      // ...and the revoked session cannot use self-service either.
      expect((await asSession(d, U.teacherA, sid(1), `SELECT * FROM public.list_my_sessions()`)).data).toHaveLength(0);
      expect((await asSession(d, U.teacherA, sid(1), `SELECT public.revoke_session('${sid(2)}')`)).ok).toBe(false);
      // The other session works.
      expect((await asSession(d, U.teacherA, sid(2), `SELECT id FROM public.course_offerings`)).data.length).toBeGreaterThan(0);
    } finally { await d.close(); }
  });

  it("lifecycle revokes every registered session of the college; old sessions stay dead after reactivation — adversarial 7, 17, 18", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1), "web");
      await register(d, U.teacherA, sid(2), "mobile");
      await register(d, U.admin, sid(3), "web");
      await register(d, U.bStudent, sid(4), "web");

      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
      const rows = await verify<{ session_id: string; status: string; revoked_reason: string | null }>(d,
        `SELECT session_id, status, revoked_reason FROM user_sessions ORDER BY session_id`);
      expect(rows).toEqual([
        { session_id: sid(1), status: "revoked", revoked_reason: "college_suspended" },
        { session_id: sid(2), status: "revoked", revoked_reason: "college_suspended" },
        { session_id: sid(3), status: "revoked", revoked_reason: "college_suspended" },
        { session_id: sid(4), status: "active", revoked_reason: null },
      ]);

      await lifecycle(d, U.superAdmin, COLLEGE_A, "ACTIVE");
      // The browser tab and the mobile app still holding the old tokens:
      expect((await asSession(d, U.studentA, sid(1), `SELECT id FROM public.fees WHERE id='${FEE_A}'`)).data).toHaveLength(0);
      expect((await asSession(d, U.teacherA, sid(2), `SELECT id FROM public.course_offerings`)).data).toHaveLength(0);
      expect((await register(d, U.studentA, sid(1))).state).toBe("revoked");
      // Signing in again — a new GoTrue session — works.
      expect((await register(d, U.studentA, sid(5))).state).toBe("active");
      expect((await asSession(d, U.studentA, sid(5), `SELECT id FROM public.fees WHERE id='${FEE_A}'`)).data).toHaveLength(1);
    } finally { await d.close(); }
  });

  it("lets the College Admin revoke its own college's sessions, but not another college's or super_admin's — adversarial 12", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      await register(d, U.bStudent, sid(2));
      await register(d, U.superAdmin, sid(3));
      await register(d, U.admin, sid(4));

      const own = await asSession(d, U.admin, sid(4), `SELECT public.revoke_session('${sid(1)}') AS r`);
      expect(own.ok, own.error ?? "").toBe(true);
      expect(await scalar(d, `SELECT revoked_reason FROM user_sessions WHERE session_id=$1`, [sid(1)])).toBe("revoked_by_admin");

      for (const target of [sid(2), sid(3)]) {
        const r = await asSession(d, U.admin, sid(4), `SELECT public.revoke_session('${target}')`);
        expect(r.ok, target).toBe(false);
        expect(r.error).toMatch(/no such session/);
      }
      expect([await sessionStatus(d, sid(2)), await sessionStatus(d, sid(3))]).toEqual(["active", "active"]);
    } finally { await d.close(); }
  });

  it("lets nobody else revoke another user's session: a teacher, a director, a student", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      for (const u of [U.teacherA, U.director, U.studentB, U.hodCse]) {
        const r = await as(d, u, `SELECT public.revoke_session('${sid(1)}')`);
        expect(r.ok, u).toBe(false);
      }
      expect(await sessionStatus(d, sid(1))).toBe("active");
    } finally { await d.close(); }
  });

  it("lets super_admin revoke Admin sessions — and only Admin sessions", async () => {
    const d = await fresh();
    try {
      await register(d, U.admin, sid(1));
      await register(d, U.studentA, sid(2));
      expect((await as(d, U.superAdmin, `SELECT public.revoke_session('${sid(1)}')`)).ok).toBe(true);
      expect(await scalar(d, `SELECT revoked_reason FROM user_sessions WHERE session_id=$1`, [sid(1)])).toBe("revoked_by_super_admin");
      expect((await as(d, U.superAdmin, `SELECT public.revoke_session('${sid(2)}')`)).ok).toBe(false);
    } finally { await d.close(); }
  });

  it("audits every revocation, under the session's college", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      await register(d, U.admin, sid(2));
      await asSession(d, U.admin, sid(2), `SELECT public.revoke_session('${sid(1)}')`);
      const [a] = await verify<Record<string, unknown>>(d,
        `SELECT college_id, user_id, action, record_id, new_value FROM audit_logs WHERE action='session.revoked'`);
      expect(a).toMatchObject({ college_id: COLLEGE_A, user_id: U.admin, record_id: sid(1) });
      expect(a.new_value).toMatchObject({ status: "revoked", reason: "revoked_by_admin", session_user_id: U.studentA });
    } finally { await d.close(); }
  });

  it("sign-out mirrors the scope: global ends every session of the user, local only the current one", async () => {
    const d = await fresh();
    try {
      await register(d, U.teacherA, sid(1));
      await register(d, U.teacherA, sid(2));
      expect((await asSession(d, U.teacherA, sid(1), `SELECT public.end_my_sessions('local') AS n`)).data[0].n).toBe(1);
      expect([await sessionStatus(d, sid(1)), await sessionStatus(d, sid(2))]).toEqual(["revoked", "active"]);
      await register(d, U.teacherA, sid(3));
      expect((await asSession(d, U.teacherA, sid(3), `SELECT public.end_my_sessions('global') AS n`)).data[0].n).toBe(2);
      expect(await scalar(d, `SELECT count(*)::int FROM user_sessions WHERE user_id=$1 AND status='active'`, [U.teacherA])).toBe(0);
      expect(await scalar(d, `SELECT count(*)::int FROM audit_logs WHERE action='session.signed_out'`)).toBe(2);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// Registry visibility
// ─────────────────────────────────────────────────────────────
describe("who can see sessions", () => {
  it("own sessions for everyone; the College Admin its college; super_admin only Admin accounts and its own", async () => {
    const d = await fresh();
    try {
      await register(d, U.studentA, sid(1));
      await register(d, U.teacherA, sid(2));
      await register(d, U.admin, sid(3));
      await register(d, U.bStudent, sid(4));
      await register(d, U.superAdmin, sid(5));
      const ids = async (uid: string, session: string) =>
        (await asSession(d, uid, session, `SELECT session_id FROM public.user_sessions ORDER BY session_id`)).data.map((r) => r.session_id);
      expect(await ids(U.studentA, sid(1))).toEqual([sid(1)]);
      expect(await ids(U.admin, sid(3))).toEqual([sid(1), sid(2), sid(3)]);
      expect(await ids(U.superAdmin, sid(5))).toEqual([sid(3), sid(5)]);
      expect(await ids(U.bStudent, sid(4))).toEqual([sid(4)]);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// The cut-over
// ─────────────────────────────────────────────────────────────
describe("session enforcement modes", () => {
  it("'register' tolerates a session never registered; 'enforce' refuses it, and a token with no session claim", async () => {
    const d = await fresh();
    try {
      const read = (session: string | null) => asSession(d, U.studentA, session, `SELECT id FROM public.fees WHERE id='${FEE_A}'`);
      expect((await read(sid(7))).data).toHaveLength(1);
      expect((await read(null)).data).toHaveLength(1);

      await register(d, U.superAdmin, sid(50));
      const r = await asSession(d, U.superAdmin, sid(50), `SELECT public.set_session_enforcement('enforce','updated mobile app confirmed registering') AS m`);
      expect(r.ok, r.error ?? "").toBe(true);

      expect((await read(sid(7))).data).toHaveLength(0);
      expect((await read(null)).data).toHaveLength(0);
      // Registering admits it again.
      expect((await register(d, U.studentA, sid(7))).state).toBe("active");
      expect((await read(sid(7))).data).toHaveLength(1);
    } finally { await d.close(); }
  });

  it("is changed only by super_admin, with a reason, audited; a no-op is refused", async () => {
    const d = await fresh();
    try {
      for (const u of [U.admin, U.director, U.studentA]) {
        const r = await as(d, u, `SELECT public.set_session_enforcement('enforce','updated mobile app confirmed registering')`);
        expect(r.error, u).toMatch(/only a super admin/);
      }
      expect((await as(d, U.superAdmin, `SELECT public.set_session_enforcement('enforce','short')`)).error).toMatch(/reason of 10/);
      expect((await as(d, U.superAdmin, `SELECT public.set_session_enforcement('register','nothing to change here')`)).error).toMatch(/already register/);
      // Direct writes are refused even for super_admin.
      const direct = await as(d, U.superAdmin, `UPDATE public.platform_settings SET value='enforce'`);
      expect(direct.ok).toBe(false);

      // Enforcing from a session the registry never admitted is refused —
      // it would lock the caller out mid-transaction.
      expect((await as(d, U.superAdmin, `SELECT public.set_session_enforcement('enforce','updated mobile app confirmed registering')`)).error)
        .toMatch(/not registered/);
      await register(d, U.superAdmin, sid(50));
      const switched = await asSession(d, U.superAdmin, sid(50), `SELECT public.set_session_enforcement('enforce','updated mobile app confirmed registering')`);
      expect(switched.ok, switched.error ?? "").toBe(true);
      const [a] = await verify<Record<string, unknown>>(d,
        `SELECT college_id, user_id, old_value, new_value FROM audit_logs WHERE action='platform.session_enforcement_changed'`);
      expect(a).toMatchObject({ college_id: PLATFORM, user_id: U.superAdmin });
      expect(a.old_value).toEqual({ value: "register" });
      expect(a.new_value).toMatchObject({ value: "enforce", reason: "updated mobile app confirmed registering" });
    } finally { await d.close(); }
  });

  it("reports readiness to super_admin only: not ready while a legacy mobile build has been seen in the last 7 days", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.admin, `SELECT public.session_enforcement_readiness()`)).ok).toBe(false);
      const readiness = async () => (await as(d, U.superAdmin, `SELECT public.session_enforcement_readiness() AS r`)).data[0].r as Record<string, unknown>;

      expect(await readiness()).toMatchObject({ mode: "register", ready: false, mobile_registered_total: 0 });
      await register(d, U.teacherA, sid(1), "mobile");
      expect(await readiness()).toMatchObject({ ready: true, active_mobile: 1 });
      await register(d, U.studentA, sid(2), "mobile-legacy");
      expect(await readiness()).toMatchObject({ ready: false, legacy_seen_last_7_days: 1, active_mobile_legacy: 1 });
      await d.exec(`UPDATE user_sessions SET last_seen_at = now() - interval '8 days' WHERE session_id='${sid(2)}'`);
      expect(await readiness()).toMatchObject({ ready: true, legacy_seen_last_7_days: 0 });
    } finally { await d.close(); }
  });
});
