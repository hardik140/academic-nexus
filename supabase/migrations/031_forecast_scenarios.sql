-- ============================================================
-- Migration 031: Forecast Scenarios
-- ============================================================
-- jsonb is the right shape here (unlike strategic_goals/milestones): a
-- scenario's assumptions/results are a flexible input/output bag with no
-- independent per-field lifecycle, mirroring invitations.metadata's existing
-- precedent. computed_results is a snapshot of the projection at save time —
-- always re-derivable live from the same rule-based projection logic, never
-- the only copy of the calculation.

CREATE TABLE IF NOT EXISTS public.forecast_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  name TEXT NOT NULL,
  assumptions JSONB NOT NULL,
  computed_results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forecast_scenarios_college ON public.forecast_scenarios(college_id);

ALTER TABLE public.forecast_scenarios ENABLE ROW LEVEL SECURITY;

-- Private per creator — a Director's saved scenarios aren't shared even
-- with other directors at the same college in this pass.
CREATE POLICY "forecast_scenarios_own" ON public.forecast_scenarios
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
    AND created_by = auth.uid()
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
    AND created_by = auth.uid()
  );
