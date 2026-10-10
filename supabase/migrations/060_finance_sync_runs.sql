-- 060: "Sync now" resumes from a durable cursor; reconciliation reads its
-- payments by keyset, not offset.
--
-- Redis transformation Phase 3, follow-up to 059.
--
-- 1. SYNC NOW. 059's queue_finance_sync_batch took its keyset cursor from the
--    caller, and the caller (syncNow) kept it in a local variable: after the
--    per-press ceiling of 200 batches it answered "incomplete", and the next
--    press began again at the window's first payment. Idempotency kept that
--    from duplicating operations, but no press ever got past the first
--    200 × 500 payments, so the rest were never queued.
--
--    Now the cursor lives in finance_sync_runs, one row per (connection,
--    window) in progress, and moves in the SAME transaction as the batch it
--    describes (finance_sync_step). A batch that fails rolls back with its
--    cursor; the next call repeats it. Any later press, by anyone in the
--    college with the right role, continues the run instead of restarting.
--
--    CONSISTENCY POLICY. A run is bounded when it opens: payments cleared,
--    in the window, with created_at <= cutoff_at (the opening transaction's
--    clock), walked in (created_at, id) order. A payment that is in that set
--    and still cleared when the cursor reaches it is queued by this run.
--    Anything created after cutoff_at, or that becomes cleared behind the
--    cursor, belongs to the NEXT run of the window, which starts at the
--    beginning (already-queued and already-linked payments are skipped, so
--    that rescan creates nothing twice). "Complete" therefore means: every
--    payment eligible at cutoff_at has been queued or was already posted.
--
-- 2. RECONCILIATION. loadLocalPayments paged with OFFSET; an insert or
--    delete between two pages shifted every later row by one, so a payment
--    could be skipped or counted twice. finance_reconciliation_payments is a
--    keyset page in the same (created_at, id) order, bounded by the run's
--    started_at.
--
-- SECURITY. finance_sync_step is SECURITY DEFINER so that the run row can be
-- written only through it: finance_sync_runs has a read policy and no write
-- policy, which keeps a person from moving a cursor or marking a run
-- complete by hand. Because DEFINER bypasses RLS, the function enforces what
-- fso_enqueue (049) did for the INVOKER version: an active finance or admin
-- profile, the connection in the caller's own college, created_by = the
-- caller. search_path is fixed and every object schema-qualified.
-- finance_reconciliation_payments is SECURITY INVOKER: payments RLS decides.
--
-- ROLLBACK: drop finance_sync_step, finance_reconciliation_payments,
-- finance_sync_runs and idx_payments_cleared_keyset (DROP INDEX CONCURRENTLY,
-- outside a transaction, avoids the write lock), then re-run 059's
-- section 13 to restore queue_finance_sync_batch. Operations already queued
-- are ordinary finance_sync_operations rows and stay valid.

-- ─────────────────────────────────────────────────────────────
-- The keyset both walks use: one college's cleared payments by (created_at, id).
--
-- Performance, not correctness: without it each batch sorts the college's
-- payments (LOCAL: 44 ms at 100k rows, 159 ms at 1M; 0.5 ms with it —
-- bench/results/phase3-index-build-local.json).
--
-- A plain build, because migrations here run as whole files (supabase db push
-- or the SQL editor), where CREATE INDEX CONCURRENTLY is refused. It holds a
-- SHARE lock on payments — writes wait — for the build (LOCAL: ~0.2 s at 100k
-- rows, ~1.1 s at 1M). The danger is the wait BEFORE it: queued behind a long
-- transaction, every payment write queues behind this. lock_timeout makes it
-- fail fast instead; every statement in this file is re-runnable.
--
-- Optional, for a large table: build it beforehand from psql, outside any
-- transaction, with exactly this definition plus CONCURRENTLY. A build that
-- failed part-way leaves an INVALID index, and an index of this name with
-- another definition is not this one: either is dropped and rebuilt here.
-- ─────────────────────────────────────────────────────────────
SET lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.idx_payments_cleared_keyset')
      AND (NOT i.indisvalid OR pg_get_indexdef(i.indexrelid) <>
           'CREATE INDEX idx_payments_cleared_keyset ON public.payments USING btree (college_id, created_at, id) WHERE (status = ''cleared''::text)')
  ) THEN
    DROP INDEX public.idx_payments_cleared_keyset;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_payments_cleared_keyset
  ON public.payments (college_id, created_at, id)
  WHERE status = 'cleared';
RESET lock_timeout;

-- ─────────────────────────────────────────────────────────────
-- 1. Sync runs
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  -- Payments created after this belong to the next run of the window.
  cutoff_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last payment of the last COMMITTED batch; null before the first.
  cursor_created TIMESTAMPTZ,
  cursor_id UUID,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETE')),
  batches INTEGER NOT NULL DEFAULT 0,
  scanned BIGINT NOT NULL DEFAULT 0,
  queued BIGINT NOT NULL DEFAULT 0,
  skipped BIGINT NOT NULL DEFAULT 0,
  -- The most recent batch failure; cleared by the next batch that commits.
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  last_step_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT fsr_period_order CHECK (period_to >= period_from),
  CONSTRAINT fsr_cursor_whole CHECK ((cursor_created IS NULL) = (cursor_id IS NULL)),
  CONSTRAINT fsr_complete_has_time CHECK ((status = 'COMPLETE') = (completed_at IS NOT NULL)),
  CONSTRAINT fsr_connection_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE CASCADE
);

-- At most one run in progress per window: concurrent presses share it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fsr_running_window
  ON public.finance_sync_runs (connection_id, period_from, period_to)
  WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS idx_fsr_college ON public.finance_sync_runs (college_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at_fsr ON public.finance_sync_runs;
CREATE TRIGGER set_updated_at_fsr BEFORE UPDATE ON public.finance_sync_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.finance_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fsr_read" ON public.finance_sync_runs;
CREATE POLICY "fsr_read" ON public.finance_sync_runs
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );
-- No INSERT/UPDATE/DELETE policy: finance_sync_step is the only writer.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.finance_sync_runs FROM anon, authenticated;
-- 053's college-lifecycle gates, which every RLS table carries: a suspended
-- college's session neither reads runs nor drives one.
DROP POLICY IF EXISTS tenant_access_gate ON public.finance_sync_runs;
CREATE POLICY tenant_access_gate ON public.finance_sync_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_access_allowed())) WITH CHECK ((SELECT public.app_access_allowed()));
DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.finance_sync_runs;
CREATE TRIGGER guard_tenant_write_access BEFORE INSERT OR UPDATE OR DELETE ON public.finance_sync_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_tenant_write_access();

-- 059's cursorless entry point: replaced by finance_sync_step, which is the
-- only way left to queue a window.
DROP FUNCTION IF EXISTS public.queue_finance_sync_batch(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INTEGER);

-- ─────────────────────────────────────────────────────────────
-- 2. One batch of a run
--
-- p_run_id NULL: find the window's run in progress, or open one. Given: the
-- run this press is already driving; if it has completed meanwhile (another
-- press finished it) the answer is its final state, not a new run.
--
-- The run row is locked FOR UPDATE for the batch, so two presses, or a press
-- and a retry, take turns on the cursor and never queue the same batch at
-- the same time. The unique (connection_id, idempotency_key) index stays the
-- final guard against a duplicate operation whatever happens here.
--
-- A batch that raises is undone to its savepoint (operations AND cursor) and
-- recorded on the run (last_error, failures); the error comes back in the
-- result, the run stays RUNNING, and the next call repeats that batch.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_sync_step(
  p_connection_id UUID,
  p_from DATE,
  p_to DATE,
  p_run_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (
  run_id UUID,
  run_status TEXT,
  scanned INTEGER,
  queued INTEGER,
  skipped INTEGER,
  run_scanned BIGINT,
  run_queued BIGINT,
  run_skipped BIGINT,
  run_batches INTEGER,
  cutoff_at TIMESTAMPTZ,
  error TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_college UUID := public.get_my_college_id();
  v_conn public.finance_integration_connections;
  v_run public.finance_sync_runs;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
  v_batch UUID[];
  v_created TIMESTAMPTZ[];
  v_n INTEGER := 0;
  v_linked INTEGER := 0;
  v_queued INTEGER := 0;
  v_attempt INTEGER;
BEGIN
  IF v_uid IS NULL OR v_college IS NULL OR COALESCE(public.get_my_role(), '') NOT IN ('finance', 'admin') THEN
    RAISE EXCEPTION 'finance sync: only finance or admin may synchronise' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'finance sync: the window must have a start on or before its end' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_conn FROM public.finance_integration_connections c
  WHERE c.id = p_connection_id AND c.college_id = v_college;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance sync: connection not found in your college' USING ERRCODE = '42501';
  END IF;
  IF v_conn.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'finance sync: this connection is % and cannot synchronise', v_conn.status USING ERRCODE = '22023';
  END IF;

  IF p_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM public.finance_sync_runs r
    WHERE r.id = p_run_id AND r.college_id = v_college AND r.connection_id = p_connection_id
      AND r.period_from = p_from AND r.period_to = p_to
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance sync: run not found for this connection and window' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Open the window's run unless one is in progress. A loser of the insert
    -- race waits for the winner's commit and then locks the winner's row;
    -- if that run completed in between, the next attempt opens a fresh one.
    FOR v_attempt IN 1..3 LOOP
      INSERT INTO public.finance_sync_runs (college_id, connection_id, period_from, period_to, created_by)
      VALUES (v_college, p_connection_id, p_from, p_to, v_uid)
      ON CONFLICT (connection_id, period_from, period_to) WHERE status = 'RUNNING' DO NOTHING;
      SELECT * INTO v_run FROM public.finance_sync_runs r
      WHERE r.connection_id = p_connection_id AND r.period_from = p_from AND r.period_to = p_to AND r.status = 'RUNNING'
      FOR UPDATE;
      EXIT WHEN FOUND;
    END LOOP;
    IF v_run.id IS NULL THEN
      RAISE EXCEPTION 'finance sync: could not open a run for this window; try again' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF v_run.status = 'RUNNING' THEN
    BEGIN
      -- The batch: the run's payments after its cursor, in a fixed order.
      SELECT array_agg(b.id ORDER BY b.created_at, b.id), array_agg(b.created_at ORDER BY b.created_at, b.id)
      INTO v_batch, v_created
      FROM (
        SELECT p.id, p.created_at
        FROM public.payments p
        WHERE p.college_id = v_college
          AND p.status = 'cleared'
          AND p.created_at >= p_from::timestamp AT TIME ZONE 'UTC'
          AND p.created_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC'
          AND p.created_at <= v_run.cutoff_at
          AND (v_run.cursor_created IS NULL OR (p.created_at, p.id) > (v_run.cursor_created, v_run.cursor_id))
        ORDER BY p.created_at, p.id
        LIMIT v_limit
      ) b;
      v_n := COALESCE(cardinality(v_batch), 0);

      IF v_n > 0 THEN
        -- Already posted (linked): skipped, never re-queued.
        SELECT count(*) INTO v_linked
        FROM public.finance_external_links l
        WHERE l.connection_id = p_connection_id AND l.entity_type = 'payment' AND l.entity_id = ANY (v_batch);

        -- Exactly the rows enqueue() makes (059's parity-tested key); an
        -- existing operation is left alone.
        INSERT INTO public.finance_sync_operations
          (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, status, created_by, system_actor)
        SELECT v_college, p_connection_id, v_conn.provider, 'payment', b.id, 'create_payment',
               public.finance_sync_idempotency_key(v_college, p_connection_id, 'payment', b.id, 'create_payment', 1),
               'PENDING', v_uid, NULL
        FROM unnest(v_batch) AS b(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.finance_external_links l
          WHERE l.connection_id = p_connection_id AND l.entity_type = 'payment' AND l.entity_id = b.id
        )
        ON CONFLICT (connection_id, idempotency_key) DO NOTHING;

        -- PENDING -> QUEUED, the one transition fso_operator_transition
        -- allowed a person: new rows and any left PENDING earlier.
        WITH q AS (
          UPDATE public.finance_sync_operations o
          SET status = 'QUEUED'
          WHERE o.connection_id = p_connection_id
            AND o.college_id = v_college
            AND o.entity_type = 'payment'
            AND o.operation = 'create_payment'
            AND o.entity_id = ANY (v_batch)
            AND o.status = 'PENDING'
          RETURNING o.id
        )
        SELECT count(*) INTO v_queued FROM q;
      END IF;

      -- The cursor moves with the batch, in this transaction.
      UPDATE public.finance_sync_runs r
      SET cursor_created = COALESCE(v_created[v_n], r.cursor_created),
          cursor_id = COALESCE(v_batch[v_n], r.cursor_id),
          batches = r.batches + 1,
          scanned = r.scanned + v_n,
          queued = r.queued + v_queued,
          skipped = r.skipped + v_linked,
          last_error = NULL,
          last_step_by = v_uid,
          status = CASE WHEN v_n < v_limit THEN 'COMPLETE' ELSE 'RUNNING' END,
          completed_at = CASE WHEN v_n < v_limit THEN now() ELSE NULL END
      WHERE r.id = v_run.id
      RETURNING * INTO v_run;
    EXCEPTION WHEN OTHERS THEN
      -- Everything since BEGIN is undone, the cursor included. Keep the failure.
      UPDATE public.finance_sync_runs r
      SET failures = r.failures + 1, last_error = SQLSTATE || ': ' || SQLERRM, last_error_at = now(), last_step_by = v_uid
      WHERE r.id = v_run.id
      RETURNING * INTO v_run;
      RETURN QUERY SELECT v_run.id, v_run.status, 0, 0, 0, v_run.scanned, v_run.queued, v_run.skipped, v_run.batches, v_run.cutoff_at, v_run.last_error;
      RETURN;
    END;
  ELSE
    v_n := 0;
  END IF;

  RETURN QUERY SELECT v_run.id, v_run.status, v_n, v_queued, v_linked, v_run.scanned, v_run.queued, v_run.skipped, v_run.batches, v_run.cutoff_at, NULL::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.finance_sync_step(UUID, DATE, DATE, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_sync_step(UUID, DATE, DATE, UUID, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 3. Reconciliation: one keyset page of a period's cleared payments
--
-- The period bounds are loadLocalPayments' own, unchanged:
-- created_at >= start 00:00:00Z and <= end 23:59:59Z. p_as_of is the run's
-- started_at: a payment created after the run began is the next run's.
-- SECURITY INVOKER: payments RLS decides which rows the caller sees.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_reconciliation_payments(
  p_college_id UUID,
  p_from DATE,
  p_to DATE,
  p_as_of TIMESTAMPTZ,
  p_after_created TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 1000
)
RETURNS TABLE (id UUID, amount NUMERIC, created_at TIMESTAMPTZ, student_id UUID, fee_id UUID)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT p.id, p.amount, p.created_at, p.student_id, p.fee_id
  FROM public.payments p
  WHERE p.college_id = p_college_id
    AND p.status = 'cleared'
    AND p.created_at >= p_from::timestamp AT TIME ZONE 'UTC'
    AND p.created_at <= (p_to::timestamp + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC'
    AND p.created_at <= p_as_of
    AND (p_after_created IS NULL OR (p.created_at, p.id) > (p_after_created, p_after_id))
  ORDER BY p.created_at, p.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;
REVOKE ALL ON FUNCTION public.finance_reconciliation_payments(UUID, DATE, DATE, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_reconciliation_payments(UUID, DATE, DATE, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) TO authenticated, service_role;
