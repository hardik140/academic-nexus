-- ============================================================
-- Migration 013: hostel_blocks admin write policy
-- ============================================================
-- hostel_blocks has had RLS enabled with only a SELECT policy since
-- migration 006. Under default-deny RLS, assignWarden's UPDATE
-- silently matched zero rows and did nothing, with no error surfaced
-- anywhere. Mirrors departments_admin exactly.

CREATE POLICY "hostel_blocks_admin" ON public.hostel_blocks
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  );
