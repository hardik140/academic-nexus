-- 056: one claim per finance sync operation.
--
-- THE DEFECT. Two finance-sync workers that read the same QUEUED operation
-- (a QStash redelivery overlapping a slow run, or a run outlasting its
-- schedule interval) could BOTH move it to PROCESSING and BOTH post the
-- receipt to the accounting system. The application claimed with
-- `UPDATE ... WHERE id = $1`, and guard_finance_sync_operation() (049)
-- returns early when the status does not change, so the second worker's
-- PROCESSING -> PROCESSING claim passed. The unique link index and the
-- immutable external id then kept the JOURNAL to one document while the
-- provider held two.
--
-- THE FIX has two layers, and either alone closes the race:
--   1. lib/finance/pipeline.ts claims with a compare-and-swap on
--      (status, attempt_number) and fences every later write on the same
--      pair. Works without this migration.
--   2. This migration makes the database refuse a second claim of an
--      operation already PROCESSING, so a future change to the application
--      cannot reopen the race.
--
-- Only the guard function changes; the trigger already points at it. Every
-- rule from 049 is kept verbatim. Safe to re-run.
--
-- VERIFY (tests/realpg-finance-claim.test.ts runs these under real
-- concurrency):
--   UPDATE finance_sync_operations SET started_at = now()
--    WHERE status = 'PROCESSING';           -- expect: already claimed
--
-- ROLLBACK: re-run the CREATE OR REPLACE FUNCTION for
-- guard_finance_sync_operation() from 049_finance_integration_hub.sql.

CREATE OR REPLACE FUNCTION public.guard_finance_sync_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finance_sync_operations is an append-only journal and cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.college_id    IS DISTINCT FROM OLD.college_id
  OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
  OR NEW.entity_type   IS DISTINCT FROM OLD.entity_type
  OR NEW.entity_id     IS DISTINCT FROM OLD.entity_id
  OR NEW.operation     IS DISTINCT FROM OLD.operation
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'finance_sync_operations: identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  -- An acknowledged external document is never renamed or unlinked. A
  -- correction is a new operation (reversal), not an edit (§72).
  IF OLD.external_id IS NOT NULL AND NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'finance_sync_operations: an external id, once recorded, is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.attempt_number < OLD.attempt_number THEN
    RAISE EXCEPTION 'finance_sync_operations: attempt_number only moves forward'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 056: an operation already PROCESSING belongs to the worker that claimed
  -- it. A second claim is PROCESSING -> PROCESSING that restamps started_at
  -- or changes the attempt number — and that is how two overlapping workers
  -- both came to post one receipt: the same-status shortcut below used to
  -- wave it through as "no change". (The old claim computed attempt_number
  -- from a stale read, so every racer wrote the SAME number; started_at,
  -- stamped with now() by each claim, is what differs.) Writes a worker
  -- legitimately makes while PROCESSING — financial year, period, request
  -- hash — touch neither column.
  IF OLD.status = 'PROCESSING' AND NEW.status = 'PROCESSING'
     AND (NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
          OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'finance sync operation: already claimed by attempt %; it cannot be claimed again', OLD.attempt_number
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'PENDING'                 THEN ARRAY['QUEUED','BLOCKED','CANCELLED']
    WHEN 'QUEUED'                  THEN ARRAY['PROCESSING','BLOCKED','CANCELLED']
    WHEN 'PROCESSING'              THEN ARRAY['SYNCED','PARTIALLY_SYNCED','FAILED','RECONCILIATION_REQUIRED','BLOCKED']
    WHEN 'PARTIALLY_SYNCED'        THEN ARRAY['PROCESSING','SYNCED','FAILED','RECONCILIATION_REQUIRED','CANCELLED']
    WHEN 'FAILED'                  THEN ARRAY['RETRYING','RECONCILIATION_REQUIRED','CANCELLED']
    WHEN 'RETRYING'                THEN ARRAY['PROCESSING','FAILED','RECONCILIATION_REQUIRED','CANCELLED']
    WHEN 'RECONCILIATION_REQUIRED' THEN ARRAY['SYNCED','FAILED','CANCELLED','PROCESSING']
    WHEN 'BLOCKED'                 THEN ARRAY['PENDING','QUEUED','CANCELLED']
    WHEN 'SYNCED'                  THEN ARRAY['RECONCILIATION_REQUIRED']
    WHEN 'CANCELLED'               THEN ARRAY[]::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'finance sync operation: status may not move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- The rule this whole subsystem exists to keep. The CHECK constraint says
  -- the same thing; this says it with the sentence an operator will read.
  IF NEW.status = 'SYNCED' AND NEW.external_id IS NULL THEN
    RAISE EXCEPTION 'finance sync operation: SYNCED requires an external identifier — an HTTP success is not an acknowledgement'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A retry may only be attempted when the previous outcome was safe to
  -- retry. 'unsafe' means the provider may already hold the document, and
  -- the path out of that is reconciliation, not another POST (§68).
  IF NEW.status = 'RETRYING' AND OLD.retry_safety IS DISTINCT FROM 'safe' THEN
    RAISE EXCEPTION 'finance sync operation: this failure is not safe to retry (%). Reconcile first.',
      COALESCE(OLD.retry_safety, 'unknown') USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
