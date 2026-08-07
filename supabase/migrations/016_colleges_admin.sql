-- ============================================================
-- Migration 016: colleges admin write policy
-- ============================================================
-- colleges has had RLS enabled with only a SELECT policy since
-- migration 006. admin/settings has always displayed institution
-- profile fields read-only, with an explicit in-code note that this
-- was deferred pending a reviewed write policy. This is that review.

CREATE POLICY "colleges_admin" ON public.colleges
  FOR UPDATE USING (
    id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  );
