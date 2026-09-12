import { describe, it, expect, vi } from "vitest";
import { as, scalar, verify, U, OFF, COLLEGE_A, COLLEGE_B, SEM_3, SEM_5, SEM_PAST } from "./staging/harness";
import { mutated } from "./staging/mutate";

/**
 * Mutation resistance for 047 §7k (academic period lifecycle) and §7l
 * (tenant consistency). Each test weakens one control, rebuilds the whole
 * database, and asserts the attack that control exists to stop now
 * SUCCEEDS.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const SEM_1 = "00000006-0000-4000-8000-000000000001";
const AY_2026 = "00000005-0000-4000-8000-000000000001";
const AY_B = "00000005-0000-4000-8000-000000000003";
const S_B = "00000004-0000-4000-8000-000000000007";

describe("lifecycle mutations", () => {
  it("detects: transition table removed — planned may jump straight to closed", async () => {
    const d = await mutated("transitions", (sql) =>
      sql.replace(
        "      (OLD.status = 'planned' AND NEW.status = 'active')\n      OR (OLD.status = 'active' AND NEW.status = 'closed')\n    ) THEN",
        "      true\n    ) THEN"
      )
    );
    try {
      const r = await as(d, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_5}' RETURNING id`);
      expect(r.rows, "mutation not detected — planned->closed accepted").toBe(1);
      expect(await scalar(d, `SELECT status FROM semesters WHERE id=$1`, [SEM_5])).toBe("closed");
    } finally { await d.close(); }
  });

  it("detects: closed-is-immutable removed — console can reopen history", async () => {
    const d = await mutated("closed immutable", (sql) =>
      sql.replace(
        "  IF OLD.status = 'closed' THEN\n    RAISE EXCEPTION '%: a closed period is immutable', TG_TABLE_NAME\n      USING ERRCODE = 'check_violation';\n  END IF;\n",
        ""
      )
    );
    try {
      // The RLS USING (status <> 'closed') still hides it from admin, so the
      // probe is the console path the trigger alone guards.
      await verify(d, `UPDATE semesters SET name='Rewritten' WHERE id=$1`, [SEM_PAST]);
      expect(await scalar(d, `SELECT name FROM semesters WHERE id=$1`, [SEM_PAST]), "mutation not detected").toBe("Rewritten");
    } finally { await d.close(); }
  });

  it("detects: RLS closed-guard removed — admin can rename a closed semester", async () => {
    // The trigger still refuses status changes and any edit to a closed row,
    // so to see the RLS layer alone the trigger's closed rule is left in
    // place and the probe targets the ONE thing the RLS guard covers that
    // the trigger also covers: a rename. Both must be removed for the rename
    // to land, so this mutation removes both — proving they are two layers,
    // not one written twice.
    const d = await mutated("rls closed guard", (sql) =>
      sql
        .replace(
          "    AND public.get_my_role() IN ('admin', 'director')\n    AND status <> 'closed'\n  )\n  WITH CHECK (\n    college_id = public.get_my_college_id()\n    AND public.get_my_role() IN ('admin', 'director')\n  );\n\nDROP POLICY IF EXISTS \"semesters_delete_manage\"",
          "    AND public.get_my_role() IN ('admin', 'director')\n  )\n  WITH CHECK (\n    college_id = public.get_my_college_id()\n    AND public.get_my_role() IN ('admin', 'director')\n  );\n\nDROP POLICY IF EXISTS \"semesters_delete_manage\""
        )
        .replace(
          "  IF OLD.status = 'closed' THEN\n    RAISE EXCEPTION '%: a closed period is immutable', TG_TABLE_NAME\n      USING ERRCODE = 'check_violation';\n  END IF;\n",
          ""
        )
    );
    try {
      const r = await as(d, U.admin, `UPDATE public.semesters SET name='Rewritten' WHERE id='${SEM_PAST}' RETURNING id`);
      expect(r.rows, "mutation not detected").toBe(1);
    } finally { await d.close(); }
  });

  it("detects: insert-as-planned removed — admin can mint a second active semester's twin as active", async () => {
    const d = await mutated("insert planned", (sql) =>
      sql.replace(
        "    AND public.get_my_role() IN ('admin', 'director')\n    AND status = 'planned'\n    AND academic_year_id IS NOT NULL\n  );",
        "    AND public.get_my_role() IN ('admin', 'director')\n    AND academic_year_id IS NOT NULL\n  );"
      )
    );
    try {
      // College B has one active semester and the index is per college, so
      // the probe inserts into college A after closing its active term.
      await verify(d, `UPDATE semesters SET status='closed' WHERE id=$1`, [SEM_3]);
      const r = await as(d, U.admin,
        `INSERT INTO public.semesters (college_id, academic_year_id, academic_year, name, start_date, end_date, status)
           VALUES ('${COLLEGE_A}','${AY_2026}','x','Sneak',  '2027-01-01','2027-05-01','active') RETURNING id`);
      expect(r.ok, "mutation not detected").toBe(true);
    } finally { await d.close(); }
  });

  it("detects: year-must-be-active rule removed", async () => {
    const d = await mutated("year active", (sql) =>
      sql.replace(
        "      IF NEW.academic_year_id IS NULL OR NOT EXISTS (\n        SELECT 1 FROM public.academic_years ay\n        WHERE ay.id = NEW.academic_year_id AND ay.status = 'active'\n      ) THEN",
        "      IF false THEN"
      )
    );
    try {
      await verify(d, `UPDATE semesters SET status='closed' WHERE id=$1`, [SEM_3]);
      const y = await as(d, U.admin, `INSERT INTO public.academic_years (college_id, name) VALUES ('${COLLEGE_A}','Planned Year') RETURNING id`);
      const s = await as(d, U.admin,
        `INSERT INTO public.semesters (college_id, academic_year_id, academic_year, name, start_date, end_date)
           VALUES ('${COLLEGE_A}','${y.data[0].id}','x','T','2027-01-01','2027-05-01') RETURNING id`);
      const r = await as(d, U.admin, `UPDATE public.semesters SET status='active' WHERE id='${s.data[0].id}' RETURNING id`);
      expect(r.rows, "mutation not detected — activated under a planned year").toBe(1);
    } finally { await d.close(); }
  });

  it("detects: role list widened — an HOD can activate a semester", async () => {
    // Widening USING alone is NOT enough: WITH CHECK independently refuses
    // the HOD's post-image (verified — the single-clause mutation was still
    // caught). Both are widened so the test speaks to the role list itself.
    const d = await mutated("role list", (sql) =>
      sql.replace(
        "  FOR UPDATE USING (\n    college_id = public.get_my_college_id()\n    AND public.get_my_role() IN ('admin', 'director')\n    AND status <> 'closed'\n  )\n  WITH CHECK (\n    college_id = public.get_my_college_id()\n    AND public.get_my_role() IN ('admin', 'director')\n  );\n\nDROP POLICY IF EXISTS \"semesters_delete_manage\"",
        "  FOR UPDATE USING (\n    college_id = public.get_my_college_id()\n    AND public.get_my_role() IN ('admin', 'director', 'hod')\n    AND status <> 'closed'\n  )\n  WITH CHECK (\n    college_id = public.get_my_college_id()\n    AND public.get_my_role() IN ('admin', 'director', 'hod')\n  );\n\nDROP POLICY IF EXISTS \"semesters_delete_manage\""
      )
    );
    try {
      await verify(d, `UPDATE semesters SET status='closed' WHERE id=$1`, [SEM_3]);
      const r = await as(d, U.hodCse, `UPDATE public.semesters SET status='active' WHERE id='${SEM_1}' RETURNING id`);
      expect(r.rows, "mutation not detected").toBe(1);
    } finally { await d.close(); }
  });
});

describe("tenant-consistency mutations", () => {
  it("detects: semesters tenant key removed — college A term under college B year", async () => {
    const d = await mutated("semester tenant fk", (sql) =>
      sql.replace(
        "ALTER TABLE public.semesters\n  ADD CONSTRAINT semesters_academic_year_tenant_fkey\n    FOREIGN KEY (academic_year_id, college_id) REFERENCES public.academic_years (id, college_id);\n",
        ""
      )
    );
    try {
      const r = await as(d, U.admin,
        `INSERT INTO public.semesters (college_id, academic_year_id, academic_year, name, start_date, end_date)
           VALUES ('${COLLEGE_A}','${AY_B}','x','Cross','2027-01-01','2027-05-01') RETURNING id`);
      expect(r.ok, "mutation not detected").toBe(true);
    } finally { await d.close(); }
  });

  it("detects: attendance student tenant key removed — college B student marked in college A", async () => {
    const d = await mutated("attendance tenant fk", (sql) =>
      sql.replace(
        ",\n  ADD CONSTRAINT attendance_student_tenant_fkey\n    FOREIGN KEY (student_id, college_id) REFERENCES public.students (id, college_id);",
        ";"
      )
    );
    try {
      const r = await as(d, U.admin,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S_B}','2026-09-01','present',auth.uid()) RETURNING id`);
      expect(r.ok, "mutation not detected").toBe(true);
      expect(await scalar(d, `SELECT college_id FROM attendance WHERE student_id=$1`, [S_B])).toBe(COLLEGE_A);
    } finally { await d.close(); }
  });

  it("detects: offering instructor tenant key removed — college B teacher on a college A offering", async () => {
    const d = await mutated("instructor tenant fk", (sql) =>
      sql.replace(
        ",\n  ADD CONSTRAINT course_offerings_instructor_tenant_fkey\n    FOREIGN KEY (instructor_id, college_id) REFERENCES public.profiles (id, college_id);",
        ";"
      )
    );
    try {
      const r = await as(d, U.admin,
        `UPDATE public.course_offerings SET instructor_id='${U.bTeacher}' WHERE id='${OFF.dsA3}' RETURNING id`);
      expect(r.rows, "mutation not detected").toBe(1);
      // and even then the foreign teacher gains nothing — the authority
      // function pins the offering's college. Two layers, both real.
      const w = await as(d, U.bTeacher,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_B}','${OFF.dsA3}','${S_B}','2026-09-01','present',auth.uid())`);
      expect(w.ok).toBe(false);
    } finally { await d.close(); }
  });
});
