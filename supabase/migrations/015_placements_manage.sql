-- ============================================================
-- Migration 015: placements write policy
-- ============================================================
-- placements has had RLS enabled with only a SELECT policy since
-- migration 006. No INSERT/UPDATE/DELETE policy has ever existed, so
-- createPlacement's INSERT is denied outright by RLS. Mirrors
-- fees_finance_manage / scholarships_finance_manage exactly.

CREATE POLICY "placements_manage" ON public.placements
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('director', 'admin')
  );
