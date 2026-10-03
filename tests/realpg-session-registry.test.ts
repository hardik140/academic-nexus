import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, COLLEGE_A } from "./staging/harness";

/**
 * Migration 054 under REAL concurrency: separate PostgreSQL sessions,
 * real row and advisory locks, real interleaving. PGlite has one connection
 * and cannot show any of this.
 *
 * Ordering inside a race is made deterministic with pg_sleep on the side
 * that must arrive second, and with a transaction held open on the side
 * that must be first. Each control is then removed — by redefining
 * register_current_session() in that one database, with the line deleted —
 * to show the race it closes is real.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("real-PostgreSQL session registry", () => {
    it.skip("BLOCKED: no PostgreSQL binary (initdb/pg_ctl/psql) on this machine", () => {});
  });
}

const sid = (n: number) => `5e550000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REASON = "Scheduled database maintenance window";

/** The claim set PostgREST would put on the request, then the limited role. */
function as(uid: string, session: string | null): string {
  const claims = JSON.stringify(session ? { sub: uid, role: "authenticated", session_id: session } : { sub: uid, role: "authenticated" });
  return `SET request.jwt.claim.sub = '${uid}';\nSET request.jwt.claims = '${claims}';\nSET ROLE authenticated;\n`;
}

/** A registration that holds its transaction open for `holdSeconds` after admission. */
function registration(uid: string, session: string, opts: { delay?: number; hold?: number } = {}): string {
  return (opts.delay ? `SELECT pg_sleep(${opts.delay});\n` : "") +
    as(uid, session) +
    `BEGIN;\nSELECT public.register_current_session('web') ->> 'state';\n` +
    (opts.hold ? `SELECT pg_sleep(${opts.hold});\n` : "") +
    `COMMIT;`;
}

const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";

/** 054's register_current_session(), with one control removed. */
function registerFunctionWithout(control: string): string {
  const sql = readFileSync("supabase/migrations/054_session_registry.sql", "utf8").replace(/\r\n/g, "\n");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.register_current_session(");
  const end = sql.indexOf("\n$$;", start) + "\n$$;".length;
  const fn = sql.slice(start, end);
  if (!fn.includes(control)) throw new Error(`control not found in register_current_session: ${control}`);
  return fn.replace(control, "-- removed by mutation");
}

maybe("real-PostgreSQL session registry", () => {
  let cluster: Cluster;
  beforeAll(() => { cluster = startCluster(); });
  afterAll(() => cluster?.stop());

  const active = (db: string, uid: string) =>
    Number(owner(cluster, db, `SELECT count(*) FROM user_sessions WHERE user_id='${uid}' AND status='active'`));

  it("two logins racing for a student's ONE slot: exactly one is admitted, the other waits on the lock and is rejected", async () => {
    const db = cluster.fork();
    try {
      const [first, second] = await concurrently(
        session(cluster, db, registration(U.studentA, sid(1), { hold: 1.5 })),
        session(cluster, db, registration(U.studentA, sid(2), { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect([firstLine(first.stdout), firstLine(second.stdout)]).toEqual(["active", "rejected"]);
      expect(active(db, U.studentA)).toBe(1);
    } finally { cluster.drop(db); }
  });

  it("six simultaneous logins for a teacher (limit 2): exactly two admitted, four rejected", async () => {
    const db = cluster.fork();
    try {
      const results = await concurrently(
        ...[1, 2, 3, 4, 5, 6].map((n) => session(cluster, db, registration(U.teacherA, sid(n), { hold: 0.2 })))
      );
      for (const r of results) expect(r.code, r.stderr).toBe(0);
      const states = results.map((r) => firstLine(r.stdout)).sort();
      expect(states).toEqual(["active", "active", "rejected", "rejected", "rejected", "rejected"]);
      expect(active(db, U.teacherA)).toBe(2);
    } finally { cluster.drop(db); }
  });

  it("MUTATION — the advisory lock removed: the same race admits BOTH sessions past a limit of one", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, registerFunctionWithout("  PERFORM pg_advisory_xact_lock(hashtextextended('user_sessions:' || v_uid::text, 0));"));
      const [first, second] = await concurrently(
        session(cluster, db, registration(U.studentA, sid(1), { hold: 1.5 })),
        session(cluster, db, registration(U.studentA, sid(2), { delay: 0.3 })),
      );
      expect([firstLine(first.stdout), firstLine(second.stdout)], `${first.stderr}${second.stderr}`).toEqual(["active", "active"]);
      expect(active(db, U.studentA)).toBe(2);
    } finally { cluster.drop(db); }
  });

  it("a login racing a suspension: whichever commits first, no session of the suspended college is left active", async () => {
    // Order 1: the login is admitted first and holds its transaction; the
    // suspension waits for the college row, then sweeps the committed login.
    const db1 = cluster.fork();
    try {
      const [login, suspend] = await concurrently(
        session(cluster, db1, registration(U.studentA, sid(1), { hold: 1.5 })),
        session(cluster, db1, `SELECT pg_sleep(0.3);\n${as(U.superAdmin, null)}SELECT lifecycle_state FROM public.set_college_lifecycle('${COLLEGE_A}','SUSPENDED','${REASON}');`),
      );
      expect(login.code, login.stderr).toBe(0);
      expect(suspend.code, suspend.stderr).toBe(0);
      expect(firstLine(login.stdout)).toBe("active");
      expect(owner(cluster, db1, `SELECT status || ':' || revoked_reason FROM user_sessions WHERE session_id='${sid(1)}'`)).toBe("revoked:college_suspended");
      expect(owner(cluster, db1, `SELECT sessions_revoked FROM college_lifecycle_events`)).toBe("1");
    } finally { cluster.drop(db1); }

    // Order 2: the suspension holds the college row; the login waits for it
    // and then sees SUSPENDED.
    const db2 = cluster.fork();
    try {
      const [suspend, login] = await concurrently(
        session(cluster, db2, `${as(U.superAdmin, null)}BEGIN;\nSELECT lifecycle_state FROM public.set_college_lifecycle('${COLLEGE_A}','SUSPENDED','${REASON}');\nSELECT pg_sleep(1.5);\nCOMMIT;`),
        session(cluster, db2, registration(U.studentA, sid(1), { delay: 0.3 })),
      );
      expect(suspend.code, suspend.stderr).toBe(0);
      expect(login.code, login.stderr).toBe(0);
      expect(firstLine(login.stdout)).toBe("college_unavailable");
      expect(owner(cluster, db2, `SELECT count(*) FROM user_sessions WHERE status='active'`)).toBe("0");
    } finally { cluster.drop(db2); }
  });

  it("MUTATION — the college SHARE lock removed: a login committing after the sweep leaves an active session that returns on reactivation", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, registerFunctionWithout(
        "  SELECT lifecycle_state INTO v_cstate FROM public.colleges WHERE id = v_profile.college_id FOR SHARE;"));
      // The suspension holds the college row; the login reads ACTIVE without a
      // lock, passes its check, and its INSERT then waits only on the foreign
      // key — so it commits AFTER the sweep, which never saw it.
      const [suspend, login] = await concurrently(
        session(cluster, db, `${as(U.superAdmin, null)}BEGIN;
SELECT lifecycle_state FROM public.set_college_lifecycle('${COLLEGE_A}','SUSPENDED','${REASON}');
SELECT pg_sleep(1.5);
COMMIT;`),
        session(cluster, db, registration(U.studentA, sid(1), { delay: 0.3 })),
      );
      expect(login.code, login.stderr).toBe(0);
      expect(suspend.code, suspend.stderr).toBe(0);
      expect(firstLine(login.stdout)).toBe("active");
      // An ACTIVE session in a SUSPENDED college, live again on reactivation.
      expect(owner(cluster, db, `SELECT lifecycle_state FROM colleges WHERE id='${COLLEGE_A}'`)).toBe("SUSPENDED");
      expect(owner(cluster, db, `SELECT status FROM user_sessions WHERE session_id='${sid(1)}'`)).toBe("active");
    } finally { cluster.drop(db); }
  });
});
