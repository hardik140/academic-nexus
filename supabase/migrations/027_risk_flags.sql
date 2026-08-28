-- ============================================================
-- Migration 027: Risk Flags (Director Command Center — Attention Center
-- + Student Risk Overview + escalation lifecycle to HOD/Warden/
-- Placement Cell/Teacher)
-- ============================================================
-- Deliberately created before escalation_notes (migration 028), which
-- needs this table to already exist for its RLS policy's subquery.
--
-- Named-student drill-down is intentionally NOT supported by this schema:
-- student_id is only set for a genuinely single-student flag reached via an
-- existing, already-authorized path (there is none for Director today) —
-- Director-facing aggregation stops at department/flag_type/batch_year via
-- affected_count. This preserves the aggregation-first requirement rather
-- than inventing a new named-student read permission.

CREATE TABLE IF NOT EXISTS public.risk_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL CHECK (flag_type IN (
    'attendance_decline', 'academic_backlog', 'fee_overdue', 'placement_inactivity',
    'hostel_issue', 'faculty_workload_gap', 'composite_student_risk', 'institutional_metric'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  scope_level TEXT NOT NULL CHECK (scope_level IN ('institution', 'department', 'student', 'faculty', 'hostel_block')),
  department_id UUID REFERENCES public.departments(id),
  student_id UUID REFERENCES public.students(id),
  affected_count INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'system_computed' rows are written by the detect-risk-flags cron via the
  -- service-role client (bypasses risk_flags_manual_create below).
  source TEXT NOT NULL DEFAULT 'system_computed' CHECK (source IN ('system_computed', 'director_manual')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'assigned', 'acknowledged', 'in_progress', 'resolved', 'dismissed'
  )),
  assigned_to UUID REFERENCES public.profiles(id),
  assigned_by UUID REFERENCES public.profiles(id),
  assigned_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_flags_college ON public.risk_flags(college_id);
CREATE INDEX IF NOT EXISTS idx_risk_flags_status ON public.risk_flags(status);
CREATE INDEX IF NOT EXISTS idx_risk_flags_assigned_to ON public.risk_flags(assigned_to);
CREATE INDEX IF NOT EXISTS idx_risk_flags_department ON public.risk_flags(department_id);
CREATE TRIGGER set_updated_at_risk_flags BEFORE UPDATE ON public.risk_flags FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.risk_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "risk_flags_read" ON public.risk_flags
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'director'
      OR assigned_to = auth.uid()
      OR (
        public.get_my_role() = 'hod'
        AND department_id IN (SELECT id FROM public.departments WHERE hod_id = auth.uid())
      )
    )
  );

CREATE POLICY "risk_flags_manual_create" ON public.risk_flags
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
  );

-- Row-level only: this covers who may touch a row at all. Which *fields*
-- a non-director assignee may change (status progression, resolution_notes)
-- vs. director-only fields (assigned_to reassignment, reviewed_by) is
-- enforced in the *Core action function, same split as hod/approvals.
CREATE POLICY "risk_flags_update" ON public.risk_flags
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'director'
      OR assigned_to = auth.uid()
    )
  );
