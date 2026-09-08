-- ============================================================
-- Migration 028: Escalation Notes
-- Shared lifecycle thread for both decisions and risk_flags
-- ============================================================
-- One polymorphic table instead of two near-identical ones
-- (decision_notes / risk_flag_notes), following documents.related_to's
-- existing no-FK-polymorphic convention: entity_id is a bare UUID, not a
-- foreign key, and the consuming code is expected to know which table
-- entity_type points to. Requires migrations 026 (decisions) and 027
-- (risk_flags) to already exist, since the RLS policies below subquery both.

CREATE TABLE IF NOT EXISTS public.escalation_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('decision', 'risk_flag')),
  entity_id UUID NOT NULL,
  author_id UUID NOT NULL REFERENCES public.profiles(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'note', 'info_request', 'info_response', 'evidence', 'status_change', 'assigned', 'acknowledged', 'resolved'
  )),
  body TEXT,
  attachment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_escalation_notes_college ON public.escalation_notes(college_id);
CREATE INDEX IF NOT EXISTS idx_escalation_notes_entity ON public.escalation_notes(entity_type, entity_id);

ALTER TABLE public.escalation_notes ENABLE ROW LEVEL SECURITY;

-- Most complex policy in this pass (subqueries into both decisions and
-- risk_flags) — verify manually against each role during implementation,
-- since silently no-op'ing new RLS policies is this codebase's documented
-- recurring bug class (see migrations 010/012/013/014/015/016).
CREATE POLICY "escalation_notes_read" ON public.escalation_notes
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'director'
      OR author_id = auth.uid()
      OR (
        entity_type = 'risk_flag'
        AND entity_id IN (SELECT id FROM public.risk_flags WHERE assigned_to = auth.uid())
      )
      OR (
        entity_type = 'decision'
        AND entity_id IN (SELECT id FROM public.decisions WHERE requested_by = auth.uid() OR delegated_to = auth.uid())
      )
    )
  );

CREATE POLICY "escalation_notes_insert" ON public.escalation_notes
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND author_id = auth.uid()
    AND (
      public.get_my_role() = 'director'
      OR (
        entity_type = 'risk_flag'
        AND entity_id IN (SELECT id FROM public.risk_flags WHERE assigned_to = auth.uid())
      )
      OR (
        entity_type = 'decision'
        AND entity_id IN (SELECT id FROM public.decisions WHERE requested_by = auth.uid() OR delegated_to = auth.uid())
      )
    )
  );
