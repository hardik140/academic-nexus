-- ============================================================
-- Migration 014: scholarships finance write policy
-- ============================================================
-- scholarships has had RLS enabled with only a SELECT policy since
-- migration 006. No INSERT/UPDATE/DELETE policy has ever existed, so
-- createScholarship's INSERT is denied outright by RLS. Mirrors
-- fees_finance_manage exactly.

CREATE POLICY "scholarships_finance_manage" ON public.scholarships
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );
