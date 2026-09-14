import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { join } from "node:path";
import { applyFullChain, migrationFiles, type ApplyStep } from "./staging/harness";

/**
 * Applies the repository's ENTIRE migration history — 001 through 047, every
 * file, unedited, in filename order — to an empty PostgreSQL.
 *
 * WHY THIS IS NOT THE SAME TEST AS migration-047-applies.test.ts
 *
 * That file installs tests/rls/pre047.sql, a hand-written approximation of
 * "the schema as it stands after 046", and runs 047 against it. It answers
 * "does 047 apply to the shape I believe the database has". This answers the
 * question underneath it: does that shape actually come out of the migration
 * history, or only out of the fixture that was written to match?
 *
 * The two can disagree. A migration renaming a constraint, an index added in
 * 021 and depended on in 047, a policy created in 038 and dropped by name in
 * 047 — every one of those is invisible to a fixture that was authored from
 * the same mental model as the migration under test.
 *
 * This is also the closest available stand-in for `supabase db push` in an
 * environment with no Docker: the same files, the same order, a real
 * PostgreSQL engine, and nothing hand-applied.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let db: PGlite;
let steps: ApplyStep[];

beforeAll(async () => {
  db = new PGlite();
  steps = await applyFullChain(db);
});

afterAll(async () => {
  await db?.close();
});

describe("the real migration chain applies to an empty database", () => {
  it("reaches the last migration with no errors", () => {
    const failed = steps.filter((s) => s.error);
    // Named explicitly: a bare `toHaveLength(0)` on a failure would print an
    // array of objects and leave the reader to find the file.
    expect(
      failed.map((s) => `${s.file}: ${s.error}`),
      "migration(s) failed"
    ).toEqual([]);
    expect(steps).toHaveLength(migrationFiles().length);
  });

  it("applies all 48 files, 046 and 047 included", () => {
    const applied = steps.map((s) => s.file);
    expect(applied).toContain("046_academic_period_foundation.sql");
    expect(applied).toContain("047_academic_transactions_on_offerings.sql");
    // Both 042s. The duplicate number is pre-existing and deliberately left
    // alone; what matters here is that neither is skipped by the ordering.
    expect(applied).toContain("042_invitation_acceptance_rls.sql");
    expect(applied).toContain("042_profile_privilege_lock.sql");
  });

  it("finishes fast enough to be a maintenance-window operation", () => {
    const total = steps.reduce((sum, s) => sum + s.ms, 0);
    // Not a benchmark — a smoke check that nothing in the chain does
    // something pathological on an empty database. Real timings depend on
    // row counts, which are zero here.
    expect(total).toBeLessThan(120_000);
  });

  it("leaves RLS enabled on every academic table", async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('attendance','marks','course_enrollments','course_offerings',
                          'students','profiles','timetable_slots',
                          'attendance_correction_requests','substitution_assignments')
        ORDER BY relname`
    );
    expect(res.rows).toHaveLength(9);
    for (const r of res.rows) {
      expect(r.relrowsecurity, `${r.relname} has RLS disabled`).toBe(true);
    }
  });

  it("installs the three offering-authority functions as SECURITY DEFINER with a pinned search_path", async () => {
    const res = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE pronamespace='public'::regnamespace
          AND proname IN ('can_write_offering_records','can_record_attendance','heads_offering_department')
        ORDER BY proname`
    );
    expect(res.rows.map((r) => r.proname)).toEqual([
      "can_record_attendance",
      "can_write_offering_records",
      "heads_offering_department",
    ]);
    for (const r of res.rows) {
      expect(r.prosecdef, `${r.proname} is not SECURITY DEFINER`).toBe(true);
      // An unpinned search_path on a SECURITY DEFINER function is the
      // classic privilege-escalation shape.
      expect(String(r.proconfig ?? ""), `${r.proname} has no pinned search_path`).toMatch(
        /search_path=/
      );
    }
  });

  it("drops every pre-047 policy that 047 supersedes", async () => {
    const res = await db.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE schemaname='public'
        AND policyname IN ('attendance_teacher_mark','attendance_teacher_update',
                           'attendance_hod_update','marks_teacher_manage',
                           'attendance_correction_update_staff')`
    );
    // Permissive policies OR together: one surviving broad policy would
    // reinstate the C1 defect no matter how narrow the new ones are.
    expect(res.rows.map((r) => r.policyname)).toEqual([]);
  });

  it("is re-runnable — applying the unreleased batch again to the SAME database changes nothing", async () => {
    // An earlier version of this test applied the chain twice to two fresh
    // databases and compared them, which proves the chain is deterministic
    // and nothing about idempotency. It passed while 047 contained a DROP
    // CONSTRAINT that fails on re-application because a foreign key still
    // depended on it. Re-applying to the database that already carries 047
    // is the only thing that catches that.
    //
    // It replays the BATCH (047, 049, 050), not 047 alone, because 050
    // supersedes objects 047 defines — gate_passes_staff is replaced there
    // by three narrower policies. Replaying only the earlier file would
    // restore the superseded FOR ALL policy and report a difference that is
    // an artefact of replaying half a deployment, not a defect. Replaying
    // the whole batch is also what an operator re-running a failed deploy
    // actually does.
    const snapshot = async () =>
      (
        await db.query<{ policies: number; constraints: number; functions: number; triggers: number }>(
          `SELECT
             (SELECT count(*)::int FROM pg_policies WHERE schemaname='public') AS policies,
             (SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace) AS constraints,
             (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace) AS functions,
             (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
               WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace) AS triggers`
        )
      ).rows[0];

    const before = await snapshot();
    const fs = await import("node:fs");
    for (const file of [
      "047_academic_transactions_on_offerings.sql",
      "049_finance_integration_hub.sql",
      "050_gate_security.sql",
    ]) {
      const sql = fs.readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8").replace(/\r\n/g, "\n");
      await expect(db.exec(sql), `${file} is not re-runnable`).resolves.toBeDefined();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rebuilds the analytics views and leaves them queryable", async () => {
    const views = await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relkind='m' AND relnamespace='public'::regnamespace
          AND relname LIKE 'mv_%' ORDER BY relname`
    );
    expect(views.rows.length).toBeGreaterThan(0);
    for (const v of views.rows) {
      // A matview that errors on SELECT is a broken deploy that no schema
      // assertion would notice.
      await expect(db.query(`SELECT * FROM public.${v.relname} LIMIT 1`)).resolves.toBeDefined();
    }
  });

  it("keeps mv_attendance_summary keyed on the offering", async () => {
    const cols = await db.query<{ attname: string }>(
      `SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid='public.mv_attendance_summary'::regclass AND a.attnum > 0
        ORDER BY a.attnum`
    );
    const names = cols.rows.map((c) => c.attname);
    expect(names).toContain("offering_id");
    // course_id is retained alongside it on purpose — the catalog identity is
    // still what a course-level report groups by.
    expect(names).toContain("course_id");
  });
});
