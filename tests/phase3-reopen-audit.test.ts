import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  stagingDb, as, scalar, verify,
  U, S, OFF, COLLEGE_A, COLLEGE_B, SEM_3, SEM_5, SEM_PAST,
} from "./staging/harness";
import { INVITE_PERMISSIONS } from "@/lib/auth/invite-tiers";
import type { UserRole } from "@/types/database";

/**
 * Migration 052 — controlled semester reopening (§6/§7) and durable audit
 * (§15).
 *
 * Two properties are under test and they pull in opposite directions, which
 * is the whole difficulty of §6:
 *
 *   1. A closed semester is still sealed. Every generic path to it — the
 *      PostgREST UPDATE, the status change, the column edit — is refused
 *      exactly as it was before 052, for everyone.
 *   2. There is now precisely ONE door: reopen_semester(), which checks the
 *      actor, demands a reason, and leaves a record. A fix that only did (1)
 *      would be the status quo; a fix that only did (2) would have traded a
 *      seal for a doorway.
 *
 * Every attack runs through `as()` (an authenticated, RLS-bound session, the
 * direct-API shape). `verify()` — owner, RLS bypassed — is used only to read
 * the postcondition afterwards, because a refusal that leaves the row changed
 * is not a refusal.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const MARK_HIST = "0000000c-0000-4000-8000-000000000001";
const B_ADMIN = "0d0d0d0d-0000-4000-8000-00000000dddd";
const PENDING = "0e0e0e0e-0000-4000-8000-00000000eeee";
/**
 * The role-change audit needs someone to demote, and demoting one of the
 * fixture teachers would quietly remove their authority over the offerings
 * that later tests write to. (It did: an earlier draft demoted U.teacherC and
 * the two marks cases below started failing for a reason that had nothing to
 * do with the audit.) A dedicated victim keeps the cases independent.
 */
const VICTIM = "0f0f0f0f-0000-4000-8000-00000000ffff";
const REASON = "Registrar correction: internal-1 marks transposed for two students";

/** A denied write either raised, or touched nothing. */
const denied = (r: { ok: boolean; rows: number; data: unknown[] }) =>
  !r.ok || (r.rows === 0 && r.data.length === 0);

const statusOf = (db: PGlite, id: string) =>
  scalar(db, `SELECT status FROM public.semesters WHERE id = $1`, [id]);

/** The audit rows 052's triggers wrote for one record, newest first. */
async function auditFor(db: PGlite, table: string, recordId: string) {
  return verify<{
    action: string; user_id: string; old_value: Record<string, unknown>; new_value: Record<string, unknown>;
  }>(
    db,
    `SELECT action, user_id, old_value, new_value FROM public.audit_logs
      WHERE table_name = $1 AND record_id = $2 ORDER BY created_at DESC, action DESC`,
    [table, recordId]
  );
}

let db: PGlite;

beforeAll(async () => {
  db = await stagingDb();
  // A College-B admin (the dataset has none) for the cross-tenant probe, and
  // a pending College-A account. Both are seeded as the owner with no session,
  // so the profile privilege trigger and its audit correctly stay out of it.
  await db.exec(`
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES ('${B_ADMIN}', 'badmin@qa.test', '{}'),
             ('${PENDING}', 'pending@qa.test', '{}'),
             ('${VICTIM}',  'victim@qa.test', '{}');
    UPDATE public.profiles SET college_id='${COLLEGE_B}', role='admin',   status='active'
      WHERE id='${B_ADMIN}';
    UPDATE public.profiles SET college_id='${COLLEGE_A}', role='admin',   status='pending'
      WHERE id='${PENDING}';
    UPDATE public.profiles SET college_id='${COLLEGE_A}', role='teacher', status='active'
      WHERE id='${VICTIM}';
  `);
});
afterAll(async () => { await db?.close(); });

// ───────────────────────────────────────────────────────────────────────
// A. The seal did not become a doorway
// ───────────────────────────────────────────────────────────────────────

describe("§6 — the generic path to a closed semester is still shut", () => {
  it("an admin cannot UPDATE a closed semester back to active", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='active' WHERE id='${SEM_PAST}' RETURNING id`);
    expect(denied(r), `the generic reopen went through: ${JSON.stringify(r.data)}`).toBe(true);
    expect(await statusOf(db, SEM_PAST)).toBe("closed");
  });

  it("an admin cannot reach the new 'reopened' state by a plain UPDATE either", async () => {
    // The state 052 adds must not become a way IN to the state it guards.
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='reopened' WHERE id='${SEM_PAST}' RETURNING id`);
    expect(denied(r), "the new state was reachable without the RPC").toBe(true);
    expect(await statusOf(db, SEM_PAST)).toBe("closed");
  });

  it("an admin cannot edit a closed semester's dates", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET end_date='2026-01-31' WHERE id='${SEM_PAST}' RETURNING id`);
    expect(denied(r)).toBe(true);
    expect(await scalar(db, `SELECT end_date::text FROM public.semesters WHERE id='${SEM_PAST}'`))
      .toBe("2025-11-30");
  });
});

// ───────────────────────────────────────────────────────────────────────
// B. Who may open the one door — §20's authorization matrix
// ───────────────────────────────────────────────────────────────────────

describe("§6 — reopen_semester() authorizes its own caller", () => {
  const reopen = (uid: string, sem: string, reason = REASON) =>
    as(db, uid, `SELECT status FROM public.reopen_semester($1, $2)`, [sem, reason]);

  it("refuses a teacher (§6: teachers must never reopen a semester)", async () => {
    const r = await reopen(U.teacherA, SEM_PAST);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may not reopen/i);
  });

  it("refuses a director — reopening sealed history is separate from managing an open term", async () => {
    // Deliberate narrowing, documented in 052 §3: a director manages the
    // periods that are OPEN (semesters_update_manage), and §6 frames
    // reopening as a distinct approved act. If college policy wants directors
    // here, that is a one-word change in the migration and this test is the
    // thing that will tell you it happened.
    const r = await reopen(U.director, SEM_PAST);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may not reopen/i);
  });

  it("refuses a pending account even though its role reads 'admin'", async () => {
    // 051 gated get_my_role() on status='active', so the role never resolves.
    const r = await reopen(PENDING, SEM_PAST);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may not reopen/i);
  });

  it("refuses a College-B admin, and does not confirm the semester exists", async () => {
    const r = await reopen(B_ADMIN, SEM_PAST);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no such semester in your college/i);
    expect(await statusOf(db, SEM_PAST)).toBe("closed");
  });

  it("refuses a blank reason", async () => {
    const r = await reopen(U.admin, SEM_PAST, "   ");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reason/i);
  });

  it("refuses a reason too short to be one", async () => {
    const r = await reopen(U.admin, SEM_PAST, "typo");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reason/i);
  });

  it("refuses a semester that is not closed", async () => {
    const r = await reopen(U.admin, SEM_3);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only a closed semester/i);
  });

  it("refuses to reopen a semester inside a CLOSED academic year", async () => {
    // SEM_PAST sits in QA 2025-26, which is closed. Reopening the semester
    // would leave a writable term inside a sealed year.
    const r = await reopen(U.admin, SEM_PAST);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/academic year is closed/i);
    expect(await statusOf(db, SEM_PAST)).toBe("closed");
  });
});

// ───────────────────────────────────────────────────────────────────────
// C. The correction window actually works — §2's "do not fix security by
//    disabling the workflow". These run in order against SEM_3.
// ───────────────────────────────────────────────────────────────────────

describe("§6 — the legitimate correction window, end to end", () => {
  it("1. an admin closes the running term", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}' RETURNING id`);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(await statusOf(db, SEM_3)).toBe("closed");
  });

  it("2. writes into it are frozen, which is what makes step 4 meaningful", async () => {
    const r = await as(db, U.teacherA,
      `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks)
         VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','midterm',100,55) RETURNING id`);
    expect(denied(r), "the closed semester accepted a write").toBe(true);
  });

  it("3. the admin reopens it with a reason", async () => {
    const r = await as(db, U.admin,
      `SELECT status FROM public.reopen_semester($1, $2)`, [SEM_3, REASON]);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.data[0]).toEqual({ status: "reopened" });
    expect(await statusOf(db, SEM_3)).toBe("reopened");
  });

  it("3b. a reopened term is not the running term", async () => {
    // §7's reason for a distinct state: is_current stays false and
    // idx_semesters_one_active is untouched, so nothing downstream mistakes a
    // correction window for the live semester.
    expect(await scalar(db, `SELECT is_current FROM public.semesters WHERE id='${SEM_3}'`)).toBe(false);
    expect(Number(await scalar(db,
      `SELECT count(*)::int FROM public.semesters WHERE college_id='${COLLEGE_A}' AND status='active'`))).toBe(0);
  });

  it("4. the correction can now be made — the entire point of reopening", async () => {
    const r = await as(db, U.teacherA,
      `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks)
         VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','midterm',100,55) RETURNING id`);
    expect(r.ok, `the reopened semester still refused the correction: ${r.error}`).toBe(true);
    expect(r.data.length).toBe(1);
  });

  it("5. but the window stays narrow: reopened cannot be promoted to active", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='active' WHERE id='${SEM_3}' RETURNING id`);
    expect(denied(r), "a reopened semester was promoted back to the running term").toBe(true);
    expect(await statusOf(db, SEM_3)).toBe("reopened");
  });

  it("5b. nor rewound to planned", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='planned' WHERE id='${SEM_3}' RETURNING id`);
    expect(denied(r)).toBe(true);
    expect(await statusOf(db, SEM_3)).toBe("reopened");
  });

  it("5c. and the term itself cannot be re-planned while reopened", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET name='Rewritten', end_date='2027-01-31' WHERE id='${SEM_3}' RETURNING id`);
    expect(denied(r), "a reopened semester's dates were editable").toBe(true);
    expect(await scalar(db, `SELECT name FROM public.semesters WHERE id='${SEM_3}'`)).toBe("QA Semester 3");
  });

  it("6. the admin closes it again", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}' RETURNING id`);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(await statusOf(db, SEM_3)).toBe("closed");
  });

  it("7. and the freeze is back — the window closed behind itself", async () => {
    const r = await as(db, U.teacherA,
      `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks)
         VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','final',100,61) RETURNING id`);
    expect(denied(r), "the semester stayed writable after being closed again").toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// D. §15 — the audit record
// ───────────────────────────────────────────────────────────────────────

describe("§15 — the database writes the academic audit itself", () => {
  it("records the reopen with actor, before, after and the reason", async () => {
    const rows = await auditFor(db, "semesters", SEM_3);
    const reopened = rows.find((r) => r.action === "semesters.reopened");
    expect(reopened, `no reopen audit row; got ${rows.map((r) => r.action).join(", ")}`).toBeDefined();
    expect(reopened!.user_id).toBe(U.admin);
    expect(reopened!.old_value).toEqual({ status: "closed" });
    expect(reopened!.new_value).toEqual({ status: "reopened", reason: REASON });
  });

  it("distinguishes the re-close from an ordinary close", async () => {
    const rows = await auditFor(db, "semesters", SEM_3);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["semesters.closed", "semesters.reopened", "semesters.reclosed"])
    );
  });

  it("does not leak the reason into an unrelated later transition", async () => {
    // The reason is transaction-local; the re-close is a different
    // transaction and must not inherit it.
    const rows = await auditFor(db, "semesters", SEM_3);
    const reclosed = rows.find((r) => r.action === "semesters.reclosed");
    expect(reclosed!.new_value).toEqual({ status: "closed" });
  });

  it("records a role change with both sides of it", async () => {
    const r = await as(db, U.admin,
      `UPDATE public.profiles SET role='student' WHERE id='${VICTIM}' RETURNING id`);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.rows, "the demotion itself did not happen, so this proves nothing").toBe(1);

    const rows = await auditFor(db, "profiles", VICTIM);
    const changed = rows.find((x) => x.action === "profiles.privilege_changed");
    expect(changed, "a role change left no audit record").toBeDefined();
    expect(changed!.user_id).toBe(U.admin);
    expect(changed!.old_value.role).toBe("teacher");
    expect(changed!.new_value.role).toBe("student");
  });

  // SEM_3 was closed again in C.6, so an edit there is frozen and would prove
  // nothing about the audit. dsA5 sits in SEM_5 (planned, never closed) and
  // S.e is enrolled in it, so these two exercise the trigger for real.
  const MARK_EDIT = "0000000c-0000-4000-8000-0000000000fe";
  const MARK_GONE = "0000000c-0000-4000-8000-0000000000ff";

  it("records a mark that was changed after the fact", async () => {
    await db.exec(
      `INSERT INTO public.marks (id, college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
         VALUES ('${MARK_EDIT}','${COLLEGE_A}','${OFF.dsA5}','${S.e}','internal_2',100,55,'${U.teacherC}');`
    );

    const r = await as(db, U.teacherC,
      `UPDATE public.marks SET obtained_marks=91 WHERE id='${MARK_EDIT}' RETURNING id`);
    expect(r.ok, `the legitimate correction was refused: ${r.error}`).toBe(true);
    expect(r.rows).toBe(1);

    const updated = (await auditFor(db, "marks", MARK_EDIT)).find((x) => x.action === "marks.updated");
    expect(updated, "a mark changed with no audit record").toBeDefined();
    expect(updated!.user_id).toBe(U.teacherC);
    expect(Number(updated!.old_value.obtained_marks)).toBe(55);
    expect(Number(updated!.new_value.obtained_marks)).toBe(91);
  });

  it("records a deleted mark, with what it held", async () => {
    await db.exec(
      `INSERT INTO public.marks (id, college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
         VALUES ('${MARK_GONE}','${COLLEGE_A}','${OFF.dsA5}','${S.e}','lab',50,44,'${U.teacherC}');`
    );

    const r = await as(db, U.teacherC, `DELETE FROM public.marks WHERE id='${MARK_GONE}'`);
    expect(r.ok, `the delete was refused: ${r.error}`).toBe(true);
    expect(r.rows).toBe(1);

    // The row is gone; what it held survives only because the trigger wrote it.
    expect(await scalar(db, `SELECT count(*)::int FROM public.marks WHERE id='${MARK_GONE}'`)).toBe(0);
    const del = (await auditFor(db, "marks", MARK_GONE)).find((x) => x.action === "marks.deleted");
    expect(del, "a mark was deleted with no audit record").toBeDefined();
    expect(Number(del!.old_value.obtained_marks)).toBe(44);
    expect(del!.new_value).toBeNull();
  });
});

/**
 * Two controls stand between an actor and their own audit trail, and they
 * behave differently. Measured, not assumed:
 *
 *   RLS   — audit_logs has SELECT and INSERT policies and no UPDATE or DELETE
 *           policy, so those statements match zero rows. The record is safe,
 *           but the refusal is SILENT: the caller gets a success and an empty
 *           result, and because no row survives the USING filter, a row-level
 *           trigger never even fires.
 *   052   — guard_audit_immutable() is the backstop for the day that changes.
 *           It cannot make today's refusal loud, and the tests below say so
 *           rather than claiming a stronger result than the code delivers.
 */
describe("§15 — an audit record is write-once", () => {
  it("an UPDATE changes nothing (silently — RLS filters the row away first)", async () => {
    const id = String(await scalar(db, `SELECT id FROM public.audit_logs LIMIT 1`));
    const before = await scalar(db, `SELECT action FROM public.audit_logs WHERE id='${id}'`);

    const r = await as(db, U.admin,
      `UPDATE public.audit_logs SET action='nothing happened' WHERE id='${id}' RETURNING id`);

    // Not an error — a no-op. That distinction is the point of this test.
    expect(r.rows === 0 && r.data.length === 0, "an audit record was editable").toBe(true);
    expect(await scalar(db, `SELECT action FROM public.audit_logs WHERE id='${id}'`)).toBe(before);
  });

  it("a DELETE removes nothing", async () => {
    const before = Number(await scalar(db, `SELECT count(*)::int FROM public.audit_logs`));
    const r = await as(db, U.admin, `DELETE FROM public.audit_logs WHERE user_id='${U.admin}'`);
    expect(r.rows, "an audit record was deletable").toBe(0);
    expect(Number(await scalar(db, `SELECT count(*)::int FROM public.audit_logs`))).toBe(before);
  });

  it("the actor does have rows to erase — so the previous test was a real attempt", async () => {
    // Without this, "0 rows deleted" would also be the result of there being
    // nothing there, and the test above would prove nothing.
    const own = await verify<{ id: string }>(db,
      `SELECT id FROM public.audit_logs WHERE user_id='${U.admin}'`);
    expect(own.length).toBeGreaterThan(0);
  });

  it("MUTATION — with a permissive policy in place, the trigger is what refuses", async () => {
    // The scenario guard_audit_immutable() exists for: someone later adds a
    // broad policy to audit_logs. Simulate exactly that, and the statement
    // must still fail — this is the evidence that the trigger is load-bearing
    // rather than decorative, since the tests above cannot reach it.
    const id = String(await scalar(db, `SELECT id FROM public.audit_logs LIMIT 1`));
    await db.exec(
      `CREATE POLICY "audit_logs_tmp_permissive" ON public.audit_logs
         FOR ALL USING (true) WITH CHECK (true);`
    );
    try {
      const upd = await as(db, U.admin,
        `UPDATE public.audit_logs SET action='nothing happened' WHERE id='${id}' RETURNING id`);
      expect(upd.ok, "a permissive policy made the audit trail editable").toBe(false);
      expect(upd.error).toMatch(/cannot be changed or removed/i);

      const del = await as(db, U.admin, `DELETE FROM public.audit_logs WHERE id='${id}'`);
      expect(del.ok, "a permissive policy made the audit trail deletable").toBe(false);
      expect(del.error).toMatch(/cannot be changed or removed/i);

      expect(await scalar(db, `SELECT action FROM public.audit_logs WHERE id='${id}'`))
        .not.toBe("nothing happened");
    } finally {
      await db.exec(`DROP POLICY IF EXISTS "audit_logs_tmp_permissive" ON public.audit_logs;`);
    }
  });
});

describe("§15/A-002 — the record shares the mutation's transaction", () => {
  it("a rolled-back transition leaves neither the change nor the audit row", async () => {
    // This is the property application-level logAudit() cannot have: it runs
    // after the commit, so a crash in between keeps the change and loses the
    // record. Here they are one unit.
    const before = Number(await scalar(db,
      `SELECT count(*)::int FROM public.audit_logs WHERE table_name='semesters' AND record_id='${SEM_5}'`));

    await db.exec(`SET request.jwt.claim.sub = '${U.admin}'; SET ROLE authenticated; BEGIN;`);
    try {
      await db.query(`UPDATE public.semesters SET status='active' WHERE id='${SEM_5}'`);
      // Mid-transaction the audit row is already there …
      const during = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.audit_logs WHERE table_name='semesters' AND record_id='${SEM_5}'`);
      expect(Number(during.rows[0].n)).toBe(before + 1);
    } finally {
      await db.exec(`ROLLBACK; RESET ROLE; RESET request.jwt.claim.sub;`);
    }

    // … and it left with the mutation it described.
    expect(await statusOf(db, SEM_5)).toBe("planned");
    expect(Number(await scalar(db,
      `SELECT count(*)::int FROM public.audit_logs WHERE table_name='semesters' AND record_id='${SEM_5}'`)))
      .toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────────────
// E. The sanction flag — stating the threat model rather than assuming it
// ───────────────────────────────────────────────────────────────────────

describe("the reopen sanction cannot be forged across the boundary it defends", () => {
  it("is not left set after the RPC returns", async () => {
    // A leaked sanction would let the NEXT statement in the same transaction
    // touch a closed semester.
    const r = await as(db, U.admin,
      `SELECT coalesce(current_setting('app.semester_reopen', true), '') AS v`);
    expect(r.data[0]).toEqual({ v: "" });
  });

  it("does not carry from one semester to another", async () => {
    // Pinning the flag to OLD.id is what stops a sanctioned reopen dragging a
    // second closed semester along in the same statement.
    const r = await as(db, U.admin,
      `UPDATE public.semesters SET status='reopened' WHERE status='closed' RETURNING id`);
    expect(denied(r)).toBe(true);
    expect(await statusOf(db, SEM_PAST)).toBe("closed");
  });

  it("cannot be forged even by a session that CAN set the GUC", async () => {
    // Worth being exact about where the strength comes from. `app.*` is an
    // unreserved GUC namespace, so any role holding a raw SQL connection may
    // set it — the flag is not secret and this test does not pretend it is.
    // It sets the flag correctly, for the right semester, and then attacks.
    //
    // The attack still fails, and it fails at a DIFFERENT control:
    // semesters_update_manage's USING clause (047) excludes a closed row, so
    // the UPDATE never reaches a row and the trigger is never consulted. Two
    // independent controls, which is the answer §0 asks for — and it means
    // the reopen path holds even if the GUC assumption behind 051's
    // app.fee_ledger_op is ever wrong.
    await db.exec(`SET request.jwt.claim.sub = '${U.admin}'; SET ROLE authenticated;`);
    let forgedRows = -1;
    let raised: string | null = null;
    try {
      await db.query(`SELECT set_config('app.semester_reopen', '${SEM_PAST}', true)`);
      const r = await db.query<{ id: string }>(
        `UPDATE public.semesters SET status='reopened' WHERE id='${SEM_PAST}' RETURNING id`);
      forgedRows = r.rows.length;
    } catch (err) {
      raised = (err as Error).message;
    } finally {
      await db.exec(`RESET ROLE; RESET request.jwt.claim.sub;`);
    }

    expect(forgedRows === 0 || raised !== null,
      `a forged sanction reopened a closed semester (rows=${forgedRows})`).toBe(true);
    expect(await statusOf(db, SEM_PAST)).toBe("closed");
  });
});

// ───────────────────────────────────────────────────────────────────────
// F. §14 — one role-transition policy, not two that drift
// ───────────────────────────────────────────────────────────────────────

describe("§14 — the invitation tier in TypeScript and in SQL are the same map", () => {
  /** Parse can_invite_role()'s CASE arms out of migration 051. */
  function sqlInviteMap(): Record<string, string[]> {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/051_phase3_hardening.sql"), "utf8");
    const body = /CREATE OR REPLACE FUNCTION public\.can_invite_role[\s\S]*?\$\$ LANGUAGE sql/.exec(sql);
    expect(body, "can_invite_role is no longer in 051 — this test is looking at the wrong place").toBeTruthy();

    const map: Record<string, string[]> = {};
    for (const m of body![0].matchAll(/WHEN '([a-z_]+)'\s*THEN p_target (?:= '([a-z_]+)'|IN \(([^)]+)\))/g)) {
      const [, actor, single, list] = m;
      map[actor] = single
        ? [single]
        : list.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    }
    return map;
  }

  it("finds the SQL map at all (guards the parser, not just the comparison)", () => {
    const sqlMap = sqlInviteMap();
    expect(Object.keys(sqlMap).sort()).toEqual(["admin", "director", "hod", "super_admin"]);
  });

  it("grants exactly the same roles on both sides", () => {
    // §14 asks for ONE authoritative role-transition policy. There are
    // physically two copies — lib/auth/invite-tiers.ts for the server action
    // and can_invite_role() for RLS and the profile trigger — because one
    // cannot call the other. This test is what makes them one policy: change
    // either and it fails here.
    const sqlMap = sqlInviteMap();
    const tsMap = Object.fromEntries(
      Object.entries(INVITE_PERMISSIONS).filter(([, targets]) => targets.length > 0)
    ) as Record<string, UserRole[]>;

    expect(Object.keys(sqlMap).sort()).toEqual(Object.keys(tsMap).sort());
    for (const actor of Object.keys(tsMap)) {
      expect([...sqlMap[actor]].sort(), `${actor}'s grants differ between SQL and TypeScript`)
        .toEqual([...tsMap[actor]].sort());
    }
  });

  it("every role the TypeScript map cannot invite is also refused by SQL", () => {
    const sqlMap = sqlInviteMap();
    for (const [actor, targets] of Object.entries(INVITE_PERMISSIONS)) {
      if (targets.length === 0) {
        expect(sqlMap[actor], `${actor} invites nobody in TS but appears in the SQL CASE`).toBeUndefined();
      }
    }
  });
});
