-- ============================================================
-- Migration 034: Director read access to complaints + gate_passes
-- ============================================================
-- Small, isolated, additive RLS fix for the Hostel Rollup screen.
-- complaints_staff and gate_passes_staff (migration 006) are admin/warden
-- only — Director currently has no RLS path into either table at all,
-- confirmed directly against 006_rls_policies.sql. Read-only, college- and
-- role-scoped, kept in its own migration for easy review/rollback.

CREATE POLICY "complaints_director_read" ON public.complaints
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
  );

CREATE POLICY "gate_passes_director_read" ON public.gate_passes
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
  );
