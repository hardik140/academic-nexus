-- ============================================================
-- Migration 029: Strategic Goals
-- ============================================================
-- goal + normalized milestones table (not jsonb — matches this schema's
-- convention that anything with independent status/lifecycle is a real
-- table, e.g. leave_requests/gate_passes, never a jsonb sub-list; the one
-- jsonb precedent, invitations.metadata, is a flexible bag with no
-- per-field lifecycle, which milestones is not).
--
-- tracking_mode is a deliberate anti-fabrication guardrail: 'auto' goals
-- must name one of a fixed 5-value metric_key (all backed by real,
-- already-audited data); 'manual' goals are explicitly director-self-
-- reported in the UI. This is what stops the tracker from silently
-- implying computed precision for domains (infrastructure, accreditation,
-- budget) that have no real backing data model in this schema.

CREATE TABLE IF NOT EXISTS public.strategic_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('auto', 'manual')),
  metric_key TEXT CHECK (metric_key IN (
    'placement_rate', 'avg_cgpa', 'attendance_pct', 'fee_collection_pct', 'hostel_occupancy_pct'
  )),
  metric_label TEXT NOT NULL,
  metric_unit TEXT,
  baseline_value NUMERIC,
  current_value NUMERIC,
  target_value NUMERIC NOT NULL,
  owner_id UUID REFERENCES public.profiles(id),
  department_id UUID REFERENCES public.departments(id),
  status TEXT NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track', 'at_risk', 'off_track', 'achieved', 'abandoned')),
  start_date DATE NOT NULL,
  target_date DATE NOT NULL,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT strategic_goals_metric_key_required_for_auto CHECK (
    (tracking_mode = 'auto' AND metric_key IS NOT NULL) OR (tracking_mode = 'manual')
  )
);

CREATE TABLE IF NOT EXISTS public.strategic_goal_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL REFERENCES public.strategic_goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed')),
  completed_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategic_goals_college ON public.strategic_goals(college_id);
CREATE INDEX IF NOT EXISTS idx_strategic_goal_milestones_goal ON public.strategic_goal_milestones(goal_id);
CREATE TRIGGER set_updated_at_strategic_goals BEFORE UPDATE ON public.strategic_goals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.strategic_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategic_goal_milestones ENABLE ROW LEVEL SECURITY;

-- Write access (create/update/delete) is director-only this pass. Allowing
-- HOD owners to report their own progress is a natural follow-up but implies
-- its own director-verification step — deliberately deferred, not built here.
CREATE POLICY "strategic_goals_read" ON public.strategic_goals
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (public.get_my_role() = 'director' OR owner_id = auth.uid())
  );

CREATE POLICY "strategic_goals_manage" ON public.strategic_goals
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
  );

CREATE POLICY "strategic_goal_milestones_read" ON public.strategic_goal_milestones
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.strategic_goals g
      WHERE g.id = goal_id
        AND g.college_id = public.get_my_college_id()
        AND (public.get_my_role() = 'director' OR g.owner_id = auth.uid())
    )
  );

CREATE POLICY "strategic_goal_milestones_manage" ON public.strategic_goal_milestones
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.strategic_goals g
      WHERE g.id = goal_id
        AND g.college_id = public.get_my_college_id()
        AND public.get_my_role() = 'director'
    )
  );
