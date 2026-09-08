-- ============================================================
-- Migration 041: Finance — Refund Requests & Financial Disputes
--
-- refund_requests: student-initiated, finance-approved reversal against one
-- specific original payment. Deliberately does NOT insert a negative-amount
-- row into `payments` to trigger update_fee_on_payment() (migration 003) —
-- that trigger's status branch has an `ELSE status` fallback that would
-- leave a fully-refunded fee's status incorrectly as 'paid' when the new
-- total drops to <= 0. Instead this table IS the reversal ledger (original
-- payment, amount, reason, approver), and approval directly/safely adjusts
-- fees.paid_amount/status and the original payment's status — see
-- app/(portal)/finance/refunds/actions.ts.
--
-- financial_disputes: structured "I paid but it shows pending"-class
-- tickets. Resolution is notes-only — it does not mutate payments/fees
-- directly; a corrective payment (if needed) goes through the existing
-- recordPayment action, not a second write path into the same tables.
--
-- Both tables follow the exact RLS shape room_transfer_requests
-- (migration 040) established for a student-request / staff-approve
-- workflow: *_read_own / *_insert_own via the student's own auth.uid(),
-- *_staff_manage FOR ALL for the owning staff role + admin.
-- ============================================================

CREATE TABLE public.refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refund_requests_college ON public.refund_requests(college_id);
CREATE INDEX idx_refund_requests_student ON public.refund_requests(student_id);
CREATE INDEX idx_refund_requests_payment ON public.refund_requests(payment_id);

ALTER TABLE public.refund_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "refund_read_own" ON public.refund_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students
      WHERE students.id = refund_requests.student_id
        AND students.user_id = auth.uid()
    )
  );

CREATE POLICY "refund_insert_own" ON public.refund_requests
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.students
      WHERE students.id = refund_requests.student_id
        AND students.user_id = auth.uid()
    )
  );

CREATE POLICY "refund_staff_manage" ON public.refund_requests
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

CREATE TABLE public.financial_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  fee_id UUID REFERENCES public.fees(id) ON DELETE SET NULL,
  payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_investigation', 'resolved', 'rejected')),
  assigned_to UUID REFERENCES public.profiles(id),
  resolution_notes TEXT,
  resolved_by UUID REFERENCES public.profiles(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_financial_disputes_college ON public.financial_disputes(college_id);
CREATE INDEX idx_financial_disputes_student ON public.financial_disputes(student_id);

ALTER TABLE public.financial_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dispute_read_own" ON public.financial_disputes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students
      WHERE students.id = financial_disputes.student_id
        AND students.user_id = auth.uid()
    )
  );

CREATE POLICY "dispute_insert_own" ON public.financial_disputes
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.students
      WHERE students.id = financial_disputes.student_id
        AND students.user_id = auth.uid()
    )
  );

CREATE POLICY "dispute_staff_manage" ON public.financial_disputes
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP TABLE IF EXISTS public.financial_disputes;
-- DROP TABLE IF EXISTS public.refund_requests;
