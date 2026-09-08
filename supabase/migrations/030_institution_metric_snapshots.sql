-- ============================================================
-- Migration 030: Institution Metric Snapshots + Command Center View State
-- ============================================================
-- The four (soon six) existing materialized views compute live rollups but
-- keep no history — "trend" and "what changed since last login" need
-- something real to diff against. This table is written on a schedule by a
-- new snapshot-health-score cron (service-role client, mirroring
-- app/api/cron/refresh-analytics), never by an authenticated user directly.
--
-- data_completeness_flags records which sub-scores were excluded from
-- overall_score for lack of real data (e.g. no faculty signal yet) — those
-- columns must be left NULL, never defaulted to 0, so "insufficient data"
-- renders honestly instead of implying a real zero score.

CREATE TABLE IF NOT EXISTS public.institution_metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  overall_score NUMERIC,
  academic_score NUMERIC,
  fee_collection_score NUMERIC,
  placement_score NUMERIC,
  hostel_score NUMERIC,
  faculty_score NUMERIC,
  risk_open_count INTEGER,
  decisions_pending_count INTEGER,
  data_completeness_flags JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_institution_metric_snapshots_college ON public.institution_metric_snapshots(college_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS public.command_center_view_state (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  last_viewed_at TIMESTAMPTZ,
  last_briefing_generated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at_command_center_view_state BEFORE UPDATE ON public.command_center_view_state FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.institution_metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.command_center_view_state ENABLE ROW LEVEL SECURITY;

-- No INSERT policy for authenticated users — written exclusively by the
-- service-role snapshot cron, same posture as the underlying MVs.
CREATE POLICY "institution_metric_snapshots_read" ON public.institution_metric_snapshots
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
  );

CREATE POLICY "command_center_view_state_self" ON public.command_center_view_state
  FOR ALL USING (
    user_id = auth.uid()
    AND public.get_my_role() = 'director'
  )
  WITH CHECK (
    user_id = auth.uid()
    AND public.get_my_role() = 'director'
  );
