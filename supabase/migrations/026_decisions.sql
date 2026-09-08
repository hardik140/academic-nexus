-- ============================================================
-- Migration 026: Decisions (Director Command Center — Decision Inbox)
-- ============================================================
-- Generic, cross-domain decision/approval entity. Deliberately NOT reusing
-- leave_requests/gate_passes (those are domain-specific with their own
-- status enums and no financial/institutional-impact fields) — this is the
-- first "any department can escalate a decision to Director" table. HOD,
-- Warden, and Placement Cell submit; only Director decides. Named-student
-- detail is never stored here — student_impact_count is an aggregate.

CREATE TABLE IF NOT EXISTS public.decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'department_change', 'hod_assignment', 'financial_exception', 'policy_exception',
    'placement_drive_approval', 'scholarship_exception', 'risk_escalation_decision', 'other'
  )),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requested_by UUID NOT NULL REFERENCES public.profiles(id),
  department_id UUID REFERENCES public.departments(id),
  urgency TEXT NOT NULL DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high', 'critical')),
  financial_impact NUMERIC(12, 2),
  student_impact_count INTEGER,
  institutional_impact_summary TEXT,
  recommendation TEXT,
  -- Convention-only association, no FK — matches documents.related_to's
  -- existing precedent (migration 005) for referencing another table
  -- without a typed polymorphic column.
  supporting_document_ids UUID[],
  deadline DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent_back', 'info_requested', 'delegated', 'withdrawn'
  )),
  decided_by UUID REFERENCES public.profiles(id),
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  delegated_to UUID REFERENCES public.profiles(id),
  -- 'system' = auto-generated from a critical risk_flag escalation (written
  -- by the service-role client, bypassing decisions_submit below).
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_college ON public.decisions(college_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON public.decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_requested_by ON public.decisions(requested_by);
CREATE TRIGGER set_updated_at_decisions BEFORE UPDATE ON public.decisions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "decisions_read" ON public.decisions
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'director'
      OR requested_by = auth.uid()
      OR delegated_to = auth.uid()
    )
  );

CREATE POLICY "decisions_submit" ON public.decisions
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND requested_by = auth.uid()
    AND public.get_my_role() IN ('hod', 'warden', 'placement_cell')
  );

CREATE POLICY "decisions_decide" ON public.decisions
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
  );
