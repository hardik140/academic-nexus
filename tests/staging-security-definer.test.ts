import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, U, S, OFF, COURSE_DS, BLOCK_A, ROOM_A101, DATE } from "./staging/harness";

/**
 * SECURITY DEFINER audit — every such function invoked DIRECTLY by an
 * unprivileged session, not merely through the policy that normally calls
 * it. A definer function runs as its owner, so the questions are: does it
 * answer only about the caller, can it be pointed at someone else's data,
 * and can it be used to make the database do expensive or privileged work.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const call = (uid: string, expr: string) => as(db, uid, `SELECT ${expr} AS v`);

describe("inventory", () => {
  it("every SECURITY DEFINER function in public is known, pinned, and accounted for here", async () => {
    const rows = await verify<{ proname: string; cfg: string | null }>(db,
      `SELECT proname, array_to_string(proconfig, ',') cfg FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef ORDER BY proname`);
    const names = rows.map((r) => r.proname);
    // Adding a definer function means adding it to this list AND deciding
    // its grant below — the test fails until both happen.
    expect(names).toEqual([
      "can_record_attendance", "can_write_offering_records", "enforce_profile_privileged_columns",
      "get_my_college_id", "get_my_email", "get_my_role",
      "handle_new_user", "heads_course_department", "heads_offering_department", "heads_programme_department",
      "heads_user_department", "refresh_analytics",
      "wardens_block", "wardens_room", "wardens_student", "wardens_student_profile",
    ]);
    for (const r of rows) expect(r.cfg, `${r.proname} search_path`).toMatch(/search_path=/);
  });
});

describe("identity helpers answer about the caller only", () => {
  it("get_my_role / get_my_college_id / get_my_email reflect the session, and take no argument to point elsewhere", async () => {
    expect((await call(U.studentA, "public.get_my_role()")).data[0].v).toBe("student");
    expect((await call(U.admin, "public.get_my_role()")).data[0].v).toBe("admin");
    const args = await verify<{ n: number }>(db, `SELECT pronargs::int n FROM pg_proc WHERE proname IN ('get_my_role','get_my_college_id','get_my_email') AND pronamespace='public'::regnamespace`);
    expect(args.every((a) => a.n === 0)).toBe(true);
  });

  it("a student asking the authority predicates about anyone's records gets false, never a row", async () => {
    for (const expr of [
      `public.can_write_offering_records('${OFF.dsA3}')`,
      `public.can_record_attendance('${OFF.dsA3}','${DATE}')`,
      `public.heads_course_department('${COURSE_DS}')`,
      `public.heads_offering_department('${OFF.dsA3}')`,
      `public.heads_user_department('${U.teacherA}')`,
      `public.heads_programme_department('00000007-0000-4000-8000-000000000001')`,
      `public.wardens_block('${BLOCK_A}')`,
      `public.wardens_room('${ROOM_A101}')`,
      `public.wardens_student('${S.a}')`,
      `public.wardens_student_profile('${U.studentA}')`,
    ]) {
      const r = await call(U.studentA, expr);
      expect(r.ok, expr).toBe(true);
      expect(r.data[0].v, expr).toBe(false);
    }
  });

  it("the same predicates are true only for the principal they describe", async () => {
    expect((await call(U.teacherA, `public.can_write_offering_records('${OFF.dsA3}')`)).data[0].v).toBe(true);
    expect((await call(U.teacherB, `public.can_write_offering_records('${OFF.dsA3}')`)).data[0].v).toBe(false);
    expect((await call(U.hodCse, `public.heads_course_department('${COURSE_DS}')`)).data[0].v).toBe(true);
    expect((await call(U.hodEce, `public.heads_course_department('${COURSE_DS}')`)).data[0].v).toBe(false);
    expect((await call(U.warden, `public.wardens_block('${BLOCK_A}')`)).data[0].v).toBe(true);
    expect((await call(U.wardenB, `public.wardens_block('${BLOCK_A}')`)).data[0].v).toBe(false);
  });

  it("a predicate cannot be used to enumerate: a non-existent id is false, not an error that differs from a foreign one", async () => {
    const missing = await call(U.studentA, `public.wardens_student('00000000-0000-4000-8000-00000000dead')`);
    const foreign = await call(U.studentA, `public.wardens_student('${S.bStudent}')`);
    expect(missing.data[0].v).toBe(false);
    expect(foreign.data[0].v).toBe(false);
    expect(missing.error).toBe(foreign.error);
  });
});

describe("privileged work", () => {
  it("refresh_analytics() cannot be executed by anon, a student, or an admin — only the service role", async () => {
    for (const uid of [U.studentA, U.admin, U.director, U.superAdmin]) {
      const r = await as(db, uid, `SELECT public.refresh_analytics()`);
      expect(r.ok, uid).toBe(false);
      expect(r.error).toMatch(/permission denied for function refresh_analytics/);
    }
    await db.exec(`SET ROLE anon`);
    try {
      await expect(db.query(`SELECT public.refresh_analytics()`)).rejects.toThrow(/permission denied/);
    } finally { await db.exec(`RESET ROLE`); }
    await db.exec(`SET ROLE service_role`);
    try {
      await expect(db.query(`SELECT public.refresh_analytics()`)).resolves.toBeDefined();
    } finally { await db.exec(`RESET ROLE`); }
  });

  it("approve_refund() is SECURITY INVOKER and closed to anon", async () => {
    const [row] = await verify<{ prosecdef: boolean }>(db, `SELECT prosecdef FROM pg_proc WHERE proname='approve_refund' AND pronamespace='public'::regnamespace`);
    expect(row.prosecdef).toBe(false);
    await db.exec(`SET ROLE anon`);
    try {
      await expect(db.query(`SELECT public.approve_refund('00000000-0000-4000-8000-00000000dead')`)).rejects.toThrow(/permission denied/);
    } finally { await db.exec(`RESET ROLE`); }
  });

  it("handle_new_user() is a trigger function and cannot be called as a query", async () => {
    const r = await as(db, U.studentA, `SELECT public.handle_new_user()`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/trigger functions can only be called as triggers/);
  });

  it("enforce_profile_privileged_columns() (042) is likewise trigger-only", async () => {
    const r = await as(db, U.studentA, `SELECT public.enforce_profile_privileged_columns()`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/trigger functions can only be called as triggers/);
  });
});

describe("no dynamic SQL, no caller-controlled identifiers", () => {
  it("no SECURITY DEFINER body contains EXECUTE or format(", async () => {
    const rows = await verify<{ proname: string; src: string }>(db,
      `SELECT proname, prosrc src FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef`);
    for (const r of rows) {
      expect(/\bEXECUTE\b/i.test(r.src), `${r.proname} uses EXECUTE`).toBe(false);
      expect(/\bformat\s*\(/i.test(r.src), `${r.proname} uses format()`).toBe(false);
    }
  });
});
