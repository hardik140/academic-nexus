-- 057: fee totals computed in PostgreSQL.
--
-- THE DEFECT. The finance dashboard and the transactions page's fee stats
-- fetched EVERY fee row of the college and summed them in JavaScript:
--
--   supabase.from("fees").select("amount, paid_amount, status, due_date")
--
-- PostgREST returns at most `max_rows` rows to an unbounded select — 1,000 by
-- default on Supabase — and says nothing. A college with more fee rows than
-- that saw totals computed from an arbitrary first page: on a 12,000-row
-- college, "total billed" read 45,000,000 instead of 540,000,000 (Redis
-- audit, bench/results/pg-offload.txt). The Redis cache in front of it hid
-- the cost and kept the wrong number for 30–60 s at a time.
--
-- THE FIX. One aggregate, in the database, over every row the caller may
-- read. SECURITY INVOKER: RLS decides which fees are summed, exactly as it
-- decided which rows the old select returned (fees_read_staff for finance and
-- admin; a student summing would get only their own).
--
-- "Overdue" and "pending" follow lib/finance-status.ts computeEffectiveFeeStatus
-- exactly (tests/staging-fee-totals.test.ts checks parity row by row):
--   terminal  = status IN ('paid','waived','refunded')     never overridden
--   overdue   = NOT terminal AND (amount - paid_amount > 0 AND due_date < today
--               OR status = 'overdue')
--   pending   = status = 'pending' AND NOT (amount - paid_amount > 0 AND due_date < today)
-- where today is the UTC date, as the TypeScript (toISOString) uses.
--
-- ROLLBACK: DROP FUNCTION public.fee_totals(uuid); and revert the two call
-- sites (app/(portal)/finance/dashboard/page.tsx, finance/transactions/actions.ts).

CREATE OR REPLACE FUNCTION public.fee_totals(p_college_id UUID)
RETURNS TABLE (
  total_billed NUMERIC,
  total_collected NUMERIC,
  total_pending NUMERIC,
  total_overdue NUMERIC,
  fee_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH f AS (
    SELECT
      amount,
      paid_amount,
      status,
      status IN ('paid', 'waived', 'refunded') AS terminal,
      (amount - paid_amount > 0 AND due_date < (now() AT TIME ZONE 'UTC')::date) AS past_due
    FROM public.fees
    WHERE college_id = p_college_id
  )
  SELECT
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(amount - paid_amount) FILTER (WHERE status = 'pending' AND NOT past_due), 0),
    COALESCE(SUM(amount - paid_amount) FILTER (WHERE NOT terminal AND (past_due OR status = 'overdue')), 0),
    COUNT(*)
  FROM f;
$$;

REVOKE ALL ON FUNCTION public.fee_totals(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fee_totals(UUID) TO authenticated;
