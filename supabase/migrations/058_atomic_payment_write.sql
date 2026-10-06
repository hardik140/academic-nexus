-- 058: atomic payment creation.
--
-- The payment trigger already locks the fee row and rejects overpayment, but
-- the application used to read the fee first and then issue a separate insert.
-- This function derives the tenant and student from the fee and performs the
-- authoritative write in one transaction, so callers cannot supply a mismatched
-- college or student and do not make a stale balance decision in application code.

CREATE OR REPLACE FUNCTION public.record_payment(
  p_fee_id UUID,
  p_amount NUMERIC,
  p_method TEXT,
  p_transaction_ref TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  payment_id UUID,
  fee_id UUID,
  student_id UUID,
  amount NUMERIC
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fee public.fees%ROWTYPE;
  v_payment public.payments%ROWTYPE;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT f.*
    INTO v_fee
    FROM public.fees f
   WHERE f.id = p_fee_id
     AND f.college_id = public.get_my_college_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.payments (
    college_id,
    fee_id,
    student_id,
    amount,
    method,
    transaction_ref,
    notes,
    status,
    processed_by
  )
  VALUES (
    v_fee.college_id,
    v_fee.id,
    v_fee.student_id,
    p_amount,
    p_method,
    NULLIF(p_transaction_ref, ''),
    p_notes,
    'cleared',
    auth.uid()
  )
  RETURNING * INTO v_payment;

  RETURN QUERY SELECT v_payment.id, v_payment.fee_id, v_payment.student_id, v_payment.amount;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment(UUID, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(UUID, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;
