import { describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { mutatedFiles } from "./staging/mutate";
import { stagingDb, as, asSession, scalar, U, S, COLLEGE_A, COLLEGE_B, FEE_A, GATE_MAIN } from "./staging/harness";

/**
 * Migrations 053 and 054, one control at a time.
 *
 * Each test builds the REAL chain with exactly one control weakened and
 * shows the attack that control exists to stop now SUCCEEDS. A mutation
 * whose pattern no longer matches throws (see staging/mutate.ts), so a
 * renamed control cannot make a test pass by mutating nothing. Where the
 * control is redefined in a later migration, the SURVIVING definition is the
 * one mutated.
 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const M53 = "053_college_lifecycle.sql";
const M54 = "054_session_registry.sql";
const REASON = "Scheduled database maintenance window";
const sid = (n: number) => `5e550000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const lifecycle = (d: PGlite, actor: string, college: string, state: string) =>
  asSession(d, actor, null, `SELECT lifecycle_state FROM public.set_college_lifecycle($1,$2,$3)`, [college, state, REASON]);
const register = async (d: PGlite, uid: string, session: string) =>
  ((await asSession(d, uid, session, `SELECT public.register_current_session('web') AS r`)).data[0]?.r as { state?: string } | undefined)?.state;
const feeVisible = async (d: PGlite, session: string | null = null) =>
  (await asSession(d, U.studentA, session, `SELECT id FROM public.fees WHERE id='${FEE_A}'`)).data.length;

async function withDb(build: Promise<PGlite>, run: (d: PGlite) => Promise<void>) {
  const d = await build;
  try { await run(d); } finally { await d.close(); }
}

describe("lifecycle controls (053/054)", () => {
  it("guard_college_lifecycle removed: the College Admin forges the lifecycle provenance of its college with a plain UPDATE", async () => {
    await withDb(mutatedFiles("no lifecycle guard", {
      [M53]: (sql) => sql.replace(
        "CREATE TRIGGER guard_college_lifecycle\n  BEFORE INSERT OR UPDATE ON public.colleges\n  FOR EACH ROW EXECUTE FUNCTION public.guard_college_lifecycle();",
        () => "-- guard_college_lifecycle removed by mutation"),
    }), async (d) => {
      // Who last changed the state, and when — rewritten by the tenant.
      const forged = await as(d, U.admin,
        `UPDATE public.colleges SET lifecycle_changed_by=auth.uid(), lifecycle_changed_at=now() - interval '30 days' WHERE id='${COLLEGE_A}'`);
      expect(forged.rows, forged.error ?? "").toBe(1);
      expect(await scalar(d, `SELECT lifecycle_changed_by FROM colleges WHERE id=$1`, [COLLEGE_A])).toBe(U.admin);

      // A direct state change is still refused without the guard — by a
      // SECOND layer: the history/audit trigger's writes land after the
      // college is already blocked, and guard_tenant_write_access refuses
      // them, rolling the UPDATE back. Defence in depth, recorded here so a
      // future change that removes both is noticed.
      const state = await as(d, U.admin, `UPDATE public.colleges SET lifecycle_state='SUSPENDED' WHERE id='${COLLEGE_A}'`);
      expect(state.ok).toBe(false);
      expect(await scalar(d, `SELECT lifecycle_state FROM colleges WHERE id=$1`, [COLLEGE_A])).toBe("ACTIVE");
    });
  });

  it("the super_admin check removed from set_college_lifecycle (054's surviving definition): the College Admin changes lifecycle", async () => {
    await withDb(mutatedFiles("no super_admin check", {
      [M54]: (sql) => sql.replace(
        "  IF public.my_operational_role() IS DISTINCT FROM 'super_admin' THEN\n    RAISE EXCEPTION 'college lifecycle: only a super admin",
        () => "  IF false THEN\n    RAISE EXCEPTION 'college lifecycle: only a super admin"),
    }), async (d) => {
      const r = await lifecycle(d, U.admin, COLLEGE_B, "SUSPENDED");
      expect(r.ok, r.error ?? "").toBe(true);
      expect(await scalar(d, `SELECT lifecycle_state FROM colleges WHERE id=$1`, [COLLEGE_B])).toBe("SUSPENDED");
    });
  });

  it("tenant_access_gate removed: a student of a college in MAINTENANCE still reads their fees through an auth.uid()-only policy", async () => {
    await withDb(mutatedFiles("no restrictive gate", {
      [M53]: (sql) => sql.replace(
        "      AND c.relname <> 'profiles'\n    ORDER BY c.relname",
        () => "      AND c.relname <> 'profiles'\n      AND false\n    ORDER BY c.relname"),
    }), async (d) => {
      await lifecycle(d, U.superAdmin, COLLEGE_A, "MAINTENANCE");
      expect(await feeVisible(d)).toBe(1);
    });
  });

  it("the lifecycle condition removed from app_access_allowed (054): a MAINTENANCE college is fully usable", async () => {
    await withDb(mutatedFiles("no lifecycle condition", {
      [M54]: (sql) => sql.replace(
        "      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')\n  ) AND public.current_session_permitted();",
        () => "  ) AND public.current_session_permitted();"),
    }), async (d) => {
      await lifecycle(d, U.superAdmin, COLLEGE_A, "MAINTENANCE");
      expect(await feeVisible(d)).toBe(1);
      expect((await as(d, U.teacherA, `SELECT id FROM public.course_offerings`)).data.length).toBeGreaterThan(0);
    });
  });

  it("guard_tenant_write_access removed: a warden of a SUSPENDED college records a manual gate movement through the SECURITY DEFINER path", async () => {
    const approvedPass = async (d: PGlite) => {
      const created = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
           VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now() - interval '1 hour', now() + interval '6 hours') RETURNING id`);
      const passId = created.data[0].id as string;
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${passId}'`);
      return passId;
    };
    const attempt = (d: PGlite, passId: string) => as(d, U.warden,
      `SELECT outcome FROM public.record_manual_gate_movement('${passId}','OUT','${GATE_MAIN}','phone battery dead at main gate')`);

    // The real chain refuses it, loudly...
    await withDb(stagingDb(), async (d) => {
      const passId = await approvedPass(d);
      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
      const r = await attempt(d, passId);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/college access/);
    });
    // ...and without the write gate the same call is RECORDED.
    await withDb(mutatedFiles("no write gate", {
      [M53]: (sql) => sql.replace(
        "    ORDER BY c.relname\n  LOOP\n    EXECUTE format('DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.%I', r.relname);",
        () => "      AND false\n    ORDER BY c.relname\n  LOOP\n    EXECUTE format('DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.%I', r.relname);"),
    }), async (d) => {
      const passId = await approvedPass(d);
      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
      const r = await attempt(d, passId);
      expect(r.ok, r.error ?? "").toBe(true);
      expect(r.data[0].outcome).toBe("RECORDED");
    });
  });

  it("the gate removed from security_has_permission (053): a guard of a MAINTENANCE college keeps its permissions", async () => {
    await withDb(mutatedFiles("ungated guard permission", {
      [M53]: (sql) => sql.replace(
        "      AND p_permission = ANY (sp.permissions)\n  ) AND public.app_access_allowed();",
        () => "      AND p_permission = ANY (sp.permissions)\n  );"),
    }), async (d) => {
      await lifecycle(d, U.superAdmin, COLLEGE_A, "MAINTENANCE");
      expect((await as(d, U.guardMain, `SELECT public.security_has_permission('gate_security.movement.view') AS v`)).data[0].v).toBe(true);
    });
  });

  it("the history immutability trigger is load-bearing: with a careless future policy and grant, only the trigger stops a super_admin erasing history", async () => {
    const careless = async (d: PGlite) => {
      await d.exec(`GRANT UPDATE, DELETE ON public.college_lifecycle_events TO authenticated;
        CREATE POLICY careless_all ON public.college_lifecycle_events FOR ALL USING (true) WITH CHECK (true);`);
      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
    };
    await withDb(stagingDb(), async (d) => {
      await careless(d);
      const r = await as(d, U.superAdmin, `DELETE FROM public.college_lifecycle_events`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/cannot be changed or removed/);
    });
    await withDb(mutatedFiles("no history guard", {
      [M53]: (sql) => sql.replace(
        "CREATE TRIGGER guard_college_lifecycle_history_immutable\n  BEFORE UPDATE OR DELETE ON public.college_lifecycle_events\n  FOR EACH ROW EXECUTE FUNCTION public.guard_college_lifecycle_history_immutable();",
        () => "-- history guard removed by mutation"),
    }), async (d) => {
      await careless(d);
      const r = await as(d, U.superAdmin, `DELETE FROM public.college_lifecycle_events`);
      expect(r.rows, r.error ?? "").toBe(1);
    });
  });
});

describe("session controls (054)", () => {
  it("the session check removed from app_access_allowed: a revoked session keeps reading", async () => {
    await withDb(mutatedFiles("no session check", {
      [M54]: (sql) => sql.replace(
        "      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')\n  ) AND public.current_session_permitted();",
        () => "      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')\n  );"),
    }), async (d) => {
      await register(d, U.studentA, sid(1));
      await asSession(d, U.studentA, sid(1), `SELECT public.end_my_sessions('local')`);
      expect(await scalar(d, `SELECT status FROM user_sessions WHERE session_id=$1`, [sid(1)])).toBe("revoked");
      expect(await feeVisible(d, sid(1))).toBe(1);
    });
  });

  it("the lifecycle sweep removed from set_college_lifecycle: after suspend and reactivate, the old session works again", async () => {
    await withDb(mutatedFiles("no lifecycle sweep", {
      [M54]: (sql) => sql.replace(
        "  IF v_state <> 'ACTIVE' THEN\n    PERFORM set_config('app.session_service', 'on', true);",
        () => "  IF false THEN\n    PERFORM set_config('app.session_service', 'on', true);"),
    }), async (d) => {
      await register(d, U.studentA, sid(1));
      await lifecycle(d, U.superAdmin, COLLEGE_A, "SUSPENDED");
      await lifecycle(d, U.superAdmin, COLLEGE_A, "ACTIVE");
      expect(await feeVisible(d, sid(1))).toBe(1);
    });
  });

  it("the limit comparison removed: a student's second device is admitted", async () => {
    await withDb(mutatedFiles("no limit", {
      [M54]: (sql) => sql.replace("IF v_limit IS NULL OR v_count < v_limit THEN", () => "IF true THEN"),
    }), async (d) => {
      expect(await register(d, U.studentA, sid(1))).toBe("active");
      expect(await register(d, U.studentA, sid(2))).toBe("active");
    });
  });

  it("the college check removed from revoke_session's Admin branch: College A's Admin revokes a College B session", async () => {
    await withDb(mutatedFiles("cross-college revoke", {
      [M54]: (sql) => sql.replace(
        "        AND v_target.college_id = public.my_operational_college_id()\n",
        () => ""),
    }), async (d) => {
      await register(d, U.bStudent, sid(1));
      const r = await as(d, U.admin, `SELECT public.revoke_session('${sid(1)}')`);
      expect(r.ok, r.error ?? "").toBe(true);
      expect(await scalar(d, `SELECT status FROM user_sessions WHERE session_id=$1`, [sid(1)])).toBe("revoked");
    });
  });

  it("the super_admin exclusion removed from revoke_session: a College Admin revokes a super_admin session in its college", async () => {
    // The QA dataset places the super_admin in College A — the case the
    // exclusion exists for, since nothing forces super admins into the
    // Platform college.
    await withDb(mutatedFiles("revoke super_admin", {
      [M54]: (sql) => sql.replace(
        "        AND NOT public.profile_is_super_admin(v_target.user_id) THEN",
        () => "        THEN"),
    }), async (d) => {
      await register(d, U.superAdmin, sid(1));
      const r = await as(d, U.admin, `SELECT public.revoke_session('${sid(1)}')`);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("the enforce-mode refusal removed: in 'enforce' a session never registered still reads", async () => {
    await withDb(mutatedFiles("enforce ignored", {
      [M54]: (sql) => sql.replace(
        "  RETURN public.session_enforcement_mode() = 'register';",
        () => "  RETURN true;"),
    }), async (d) => {
      await register(d, U.superAdmin, sid(50));
      const s = await asSession(d, U.superAdmin, sid(50), `SELECT public.set_session_enforcement('enforce','updated mobile app confirmed registering')`);
      expect(s.ok, s.error ?? "").toBe(true);
      expect(await feeVisible(d, sid(77))).toBe(1);
    });
  });
});
