-- ============================================================
-- Migration 021: college_id indexes on high-traffic tenant tables
-- ============================================================
-- fees, payments, marks, gate_passes, leave_requests, placements, and
-- library_issued all carry a NOT NULL college_id (see migrations 003, 004,
-- 005) but were never given an index on it, despite college_id being the
-- dominant RLS predicate on every one of them. Harmless at today's row
-- counts; each becomes a sequential scan under its own RLS policy as a
-- college's history accumulates. Purely additive — no data or behavior
-- change, safe to apply independently of any application deploy.

CREATE INDEX IF NOT EXISTS idx_fees_college ON public.fees(college_id);
CREATE INDEX IF NOT EXISTS idx_payments_college ON public.payments(college_id);
CREATE INDEX IF NOT EXISTS idx_marks_college ON public.marks(college_id);
CREATE INDEX IF NOT EXISTS idx_gate_passes_college ON public.gate_passes(college_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_college ON public.leave_requests(college_id);
CREATE INDEX IF NOT EXISTS idx_placements_college ON public.placements(college_id);
CREATE INDEX IF NOT EXISTS idx_library_issued_college ON public.library_issued(college_id);
