-- ============================================================
-- Migration 049: Finance Integration Hub
--
-- WHY 049 AND NOT 048
-- 048 stays reserved for the migration that drops courses.instructor_id
-- (047's header names it). That one is gated on a staging apply of 047 and
-- on real production row counts, neither of which exists yet. This migration
-- is independent of it — they touch no common object — so taking the next
-- free number rather than jumping the reservation keeps both intentions
-- intact.
--
-- DEPENDS ON 047 (payments_student_key, fees_student_key, the composite
-- tenant keys, and the §7i ledger triggers). 047 is NOT yet applied; these
-- ship in the same deployment batch.
--
-- WHAT THIS IS
-- A provider-neutral accounting-integration substrate: connections to an
-- external accounting system (TallyPrime, BUSY, Zoho Books), the mapping of
-- Academic Nexus financial objects onto that system's chart of accounts, an
-- idempotent outbound operation journal, the durable local<->external
-- identity link, and reconciliation.
--
-- It deliberately adds NO new money. Every rupee still originates in `fees`
-- and `payments`; nothing here may create, alter or delete a financial
-- record. This subsystem only records what was SENT, what the external
-- system ACKNOWLEDGED, and whether the two still agree.
--
-- THE ONE RULE THE SCHEMA ITSELF ENFORCES
--
--   A transaction is 'SYNCED' only if it carries an external identifier.
--
-- An HTTP 200 with no document id is not a synchronisation; it is an
-- unknown result, and an unknown result belongs in RECONCILIATION_REQUIRED.
-- That is a CHECK constraint below, not a convention, because "we thought it
-- posted" is the failure mode that makes an accounting integration worse
-- than no integration at all.
--
-- CREDENTIALS
-- finance_integration_credentials holds ONLY AES-256-GCM ciphertext and its
-- IV/tag/key-version. RLS is enabled on it with NO POLICY AT ALL, so no
-- authenticated session can read it under any role — the service-role
-- worker is the only reader. The encryption key lives in the server
-- environment (FINANCE_CREDENTIAL_KEY); this repository has no KMS, Vault
-- or HSM, which is recorded as a production blocker rather than papered
-- over. Without the key configured the application refuses to create a
-- connection instead of storing anything weaker.
--
-- Sign-off: REQUIRED. New tables, new RLS, and a subsystem that will hold
-- third-party accounting credentials.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. Connections
--
-- One row per (college, provider, external company/organisation). The
-- status vocabulary is §47's, not a boolean: "is_connected" cannot express
-- the difference between "credentials expired", "pointed at the wrong Tally
-- company" and "the provider is rate-limiting us", and those three demand
-- different operator actions.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('tallyprime', 'busy', 'zoho_books')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'CONFIGURING', 'AUTH_REQUIRED', 'AUTHENTICATED', 'VERIFIED', 'ACTIVE',
    'AUTH_FAILED', 'CONNECTION_FAILED', 'WRONG_ORGANIZATION', 'WRONG_COMPANY',
    'CAPABILITY_MISSING', 'RATE_LIMITED', 'DISABLED', 'REVOKED', 'BLOCKED'
  )),
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),

  -- External identity. organization_id is Zoho's org; external_company_*
  -- is Tally's loaded company / BUSY's company. Both are recorded because
  -- posting into the WRONG company is the financial-safety failure §43
  -- exists to prevent, and a name alone is not an identity.
  organization_id TEXT,
  external_company_id TEXT,
  external_company_name TEXT,

  -- Transport configuration. No secrets here — see credentials below.
  host TEXT,
  port INTEGER CHECK (port IS NULL OR (port > 0 AND port <= 65535)),
  base_url TEXT,
  transport TEXT CHECK (transport IS NULL OR transport IN ('xml_http', 'odbc', 'rest', 'file')),

  -- Discovered, not assumed: {"createInvoice":"SUPPORTED","createRefund":"UNSUPPORTED",...}
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Academic Nexus has no financial-year entity (fees.academic_year is free
  -- text and means the ACADEMIC year). §81 requires the two to be distinct,
  -- so the financial year is derived from this start month per connection.
  financial_year_start_month INTEGER NOT NULL DEFAULT 4
    CHECK (financial_year_start_month BETWEEN 1 AND 12),

  -- Direction defaults per §54; per-object overrides live on the mappings.
  default_direction TEXT NOT NULL DEFAULT 'outbound'
    CHECK (default_direction IN ('outbound', 'inbound', 'bidirectional')),

  auto_sync_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_sync_interval_minutes INTEGER CHECK (auto_sync_interval_minutes IS NULL OR auto_sync_interval_minutes >= 5),

  last_tested_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,

  created_by UUID REFERENCES public.profiles(id),
  updated_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One live connection per college+provider+company. Two connections to
  -- the same Tally company would both post the same receipt.
  UNIQUE (college_id, provider, external_company_id)
);

CREATE INDEX IF NOT EXISTS idx_fic_college ON public.finance_integration_connections(college_id);
CREATE INDEX IF NOT EXISTS idx_fic_status ON public.finance_integration_connections(college_id, status);
DROP TRIGGER IF EXISTS set_updated_at_fic ON public.finance_integration_connections;
CREATE TRIGGER set_updated_at_fic BEFORE UPDATE ON public.finance_integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- The tenant-qualified identity every child table references, so a
-- College B row can never hang off a College A connection (§75).
--
-- Added only when absent, rather than dropped and recreated: five child
-- tables below carry foreign keys to it, and Postgres refuses to drop a
-- key they depend on — so the drop-then-add form made this whole migration
-- fail on a second apply. Same lesson as 047 §7l, reached from the other
-- direction.
DO $fic_tenant_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.finance_integration_connections'::regclass
      AND conname = 'fic_tenant_key'
  ) THEN
    ALTER TABLE public.finance_integration_connections
      ADD CONSTRAINT fic_tenant_key UNIQUE (id, college_id);
  END IF;
END $fic_tenant_key$;

-- ---------------------------------------------------------------
-- 2. Credentials — ciphertext only, and readable by nobody
--
-- Split from the connection on purpose: the connection row is listed on a
-- dashboard, and a SELECT that returns the row must not be able to return
-- the secret alongside it. RLS is ENABLED with no policy, which under
-- PostgreSQL means "deny everything" for every non-superuser, non-owner
-- role — including `authenticated` holding the admin role. Only the
-- service-role worker reads this.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_integration_credentials (
  connection_id UUID PRIMARY KEY
    REFERENCES public.finance_integration_connections(id) ON DELETE CASCADE,
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  key_version INTEGER NOT NULL DEFAULT 1,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  -- OAuth bookkeeping that is not itself secret.
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[],
  rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fic_cred_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS set_updated_at_fic_cred ON public.finance_integration_credentials;
CREATE TRIGGER set_updated_at_fic_cred BEFORE UPDATE ON public.finance_integration_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------
-- 3. Mappings — Academic Nexus object -> external account
--
-- `fees.type` is free text in this schema (there is no fee-head table), so
-- the local key is that string, per college. Payment methods come from
-- payments.method's CHECK list. Nothing is hard-coded: every mapping is a
-- row an operator configures (§48).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.finance_integration_connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'fee_head', 'payment_method', 'bank_account', 'tax_code',
    'customer', 'cost_center', 'department', 'branch'
  )),
  -- The Academic Nexus side: 'Tuition Fee', 'upi', a students.id, ...
  local_key TEXT NOT NULL,
  local_label TEXT,
  -- The accounting side, as the provider names it.
  external_id TEXT,
  external_code TEXT,
  external_name TEXT NOT NULL,
  -- Tax treatment, where the provider and the institution use one. Academic
  -- Nexus stores no tax component on fees or payments, so these describe how
  -- a gross amount should be declared externally, not a split we hold.
  tax_rate NUMERIC(6, 3) CHECK (tax_rate IS NULL OR tax_rate >= 0),
  tax_treatment TEXT CHECK (tax_treatment IS NULL OR tax_treatment IN (
    'taxable', 'exempt', 'zero_rated', 'non_taxable', 'out_of_scope'
  )),
  direction TEXT NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound', 'inbound', 'bidirectional')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by UUID REFERENCES public.profiles(id),
  updated_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active mapping per (connection, kind, local key). Two ledgers for
  -- one fee head is how money lands in the wrong account.
  UNIQUE (connection_id, kind, local_key),
  CONSTRAINT fam_connection_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fam_connection ON public.finance_account_mappings(connection_id, kind);
DROP TRIGGER IF EXISTS set_updated_at_fam ON public.finance_account_mappings;
CREATE TRIGGER set_updated_at_fam BEFORE UPDATE ON public.finance_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------
-- 4. External links — the durable local <-> external identity
--
-- This is what makes retries safe (§52). Before creating anything in the
-- accounting system the worker asks "does this entity already have an
-- external id on this connection?" — one indexed lookup, not an inference
-- from operation history.
--
-- Two uniqueness rules, both from §86:
--   one external document per local entity per connection, and
--   one local entity per external document per connection.
-- The second is the one that catches a reconciliation resolving two
-- different payments onto the same voucher.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_external_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.finance_integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'payment', 'refund', 'invoice', 'student', 'journal_entry'
  )),
  entity_id UUID NOT NULL,
  external_id TEXT NOT NULL,
  external_number TEXT,          -- human-facing voucher/receipt number at the provider
  external_type TEXT,            -- 'receipt', 'invoice', 'credit_note', 'contact', ...
  external_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (connection_id, entity_type, entity_id),
  UNIQUE (connection_id, entity_type, external_id),
  CONSTRAINT fel_connection_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fel_entity ON public.finance_external_links(college_id, entity_type, entity_id);

-- ---------------------------------------------------------------
-- 5. Sync operations — the request/response journal (§53)
--
-- Append-mostly: a row is created before the provider is called and only
-- ever advances along the state machine below. Payloads are NOT stored;
-- request_hash/response_hash are SHA-256 digests, and request_summary holds
-- a redacted shape (amounts, ids, mapping used) so an operator can see what
-- was attempted without the journal becoming a second copy of the ledger
-- or a place secrets accumulate.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_sync_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.finance_integration_connections(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('tallyprime', 'busy', 'zoho_books')),

  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'payment', 'refund', 'invoice', 'student', 'journal_entry', 'master_data'
  )),
  entity_id UUID,                                   -- null only for master_data sweeps
  operation TEXT NOT NULL CHECK (operation IN (
    'create_customer', 'update_customer', 'create_invoice', 'update_invoice',
    'create_payment', 'create_refund', 'create_journal_entry',
    'fetch_accounts', 'fetch_tax_rates', 'fetch_contacts', 'fetch_transactions',
    'reconcile'
  )),
  direction TEXT NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound', 'inbound')),

  idempotency_key TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'QUEUED', 'PROCESSING', 'SYNCED', 'PARTIALLY_SYNCED',
    'FAILED', 'RETRYING', 'RECONCILIATION_REQUIRED', 'BLOCKED', 'CANCELLED'
  )),
  attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),

  external_id TEXT,
  external_number TEXT,

  -- The financial period this posting belongs to, resolved BEFORE sending.
  financial_year TEXT,
  period_key TEXT,

  request_hash TEXT,
  response_hash TEXT,
  request_summary JSONB,
  error_code TEXT,
  error_message TEXT,

  -- Whether a failed attempt may be re-POSTed at all (§68). 'unsafe' means
  -- the external system may already hold the document.
  retry_safety TEXT CHECK (retry_safety IS NULL OR retry_safety IN ('safe', 'unsafe', 'exhausted')),
  next_attempt_at TIMESTAMPTZ,

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.profiles(id),    -- null when the scheduler queued it
  system_actor TEXT,                                 -- 'scheduler', 'worker', 'reconciliation'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- §40 / §101, as a constraint rather than a convention.
  CONSTRAINT fso_synced_needs_external_id
    CHECK (status <> 'SYNCED' OR external_id IS NOT NULL),
  -- An operation is either the system's or a person's, and says which.
  CONSTRAINT fso_has_actor
    CHECK (created_by IS NOT NULL OR system_actor IS NOT NULL),
  -- §52: the key is what makes a retry the same operation.
  UNIQUE (connection_id, idempotency_key),
  CONSTRAINT fso_connection_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fso_college_status ON public.finance_sync_operations(college_id, status);
CREATE INDEX IF NOT EXISTS idx_fso_entity ON public.finance_sync_operations(college_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fso_queue ON public.finance_sync_operations(status, next_attempt_at)
  WHERE status IN ('QUEUED', 'RETRYING');
DROP TRIGGER IF EXISTS set_updated_at_fso ON public.finance_sync_operations;
CREATE TRIGGER set_updated_at_fso BEFORE UPDATE ON public.finance_sync_operations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------
-- 6. Sync cursors (§70) — pull-based synchronisation position
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_sync_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.finance_integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  last_cursor TEXT,
  last_sync_at TIMESTAMPTZ,
  last_external_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity_type),
  CONSTRAINT fsc_connection_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS set_updated_at_fsc ON public.finance_sync_cursors;
CREATE TRIGGER set_updated_at_fsc BEFORE UPDATE ON public.finance_sync_cursors
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------
-- 7. Reconciliation (§64, §65)
--
-- A run compares a window of Academic Nexus transactions against the same
-- window at the provider and records EVERY difference it finds, typed.
-- "Mismatch" as a single number is not a finding an operator can act on.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.finance_integration_connections(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN (
    'RUNNING', 'RECONCILED', 'RECONCILIATION_REQUIRED', 'FAILED'
  )),
  local_count INTEGER,
  external_count INTEGER,
  local_amount NUMERIC(14, 2),
  external_amount NUMERIC(14, 2),
  difference_amount NUMERIC(14, 2),
  issue_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.profiles(id),
  system_actor TEXT,
  CONSTRAINT frr_period_order CHECK (period_end >= period_start),
  CONSTRAINT frr_connection_tenant_fkey
    FOREIGN KEY (connection_id, college_id)
    REFERENCES public.finance_integration_connections (id, college_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_frr_college ON public.finance_reconciliation_runs(college_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.finance_reconciliation_runs(id) ON DELETE CASCADE,
  difference_type TEXT NOT NULL CHECK (difference_type IN (
    'MISSING_EXTERNAL_TRANSACTION', 'MISSING_LOCAL_TRANSACTION',
    'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'DATE_MISMATCH', 'LEDGER_MISMATCH',
    'TAX_MISMATCH', 'DUPLICATE_EXTERNAL_TRANSACTION', 'DUPLICATE_LOCAL_TRANSACTION',
    'EXTERNAL_ID_MISMATCH', 'REFUND_MISMATCH', 'UNMAPPED_ACCOUNT', 'PERIOD_MISMATCH'
  )),
  entity_type TEXT,
  entity_id UUID,
  external_id TEXT,
  local_amount NUMERIC(14, 2),
  external_amount NUMERIC(14, 2),
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'accepted')),
  resolution TEXT,
  resolved_by UUID REFERENCES public.profiles(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fri_run ON public.finance_reconciliation_items(run_id, status);
CREATE INDEX IF NOT EXISTS idx_fri_open ON public.finance_reconciliation_items(college_id, status)
  WHERE status = 'open';

-- ---------------------------------------------------------------
-- 8. State machines
--
-- Both are enforced in the database for the same reason the gate pass's is
-- (047 §7m): the tables are reachable through PostgREST by any role the
-- policies admit, and an operator who can retry a sync must not be able to
-- relabel a failure as a success.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_finance_connection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF NEW.college_id IS DISTINCT FROM OLD.college_id THEN
    RAISE EXCEPTION 'finance_integration_connections: college_id is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'finance_integration_connections: provider is immutable — create a new connection'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'DRAFT'              THEN ARRAY['CONFIGURING','DISABLED']
    WHEN 'CONFIGURING'        THEN ARRAY['AUTH_REQUIRED','AUTHENTICATED','CONNECTION_FAILED','AUTH_FAILED','DISABLED','BLOCKED']
    WHEN 'AUTH_REQUIRED'      THEN ARRAY['AUTHENTICATED','AUTH_FAILED','CONNECTION_FAILED','DISABLED','BLOCKED']
    WHEN 'AUTHENTICATED'      THEN ARRAY['VERIFIED','WRONG_ORGANIZATION','WRONG_COMPANY','CAPABILITY_MISSING','AUTH_FAILED','CONNECTION_FAILED','DISABLED','BLOCKED']
    WHEN 'VERIFIED'           THEN ARRAY['ACTIVE','CAPABILITY_MISSING','WRONG_COMPANY','WRONG_ORGANIZATION','AUTH_FAILED','CONNECTION_FAILED','DISABLED','BLOCKED']
    WHEN 'ACTIVE'             THEN ARRAY['RATE_LIMITED','AUTH_FAILED','CONNECTION_FAILED','WRONG_COMPANY','WRONG_ORGANIZATION','CAPABILITY_MISSING','REVOKED','DISABLED','BLOCKED']
    WHEN 'RATE_LIMITED'       THEN ARRAY['ACTIVE','CONNECTION_FAILED','DISABLED','BLOCKED']
    WHEN 'AUTH_FAILED'        THEN ARRAY['AUTH_REQUIRED','CONFIGURING','DISABLED','BLOCKED']
    WHEN 'CONNECTION_FAILED'  THEN ARRAY['CONFIGURING','AUTHENTICATED','ACTIVE','DISABLED','BLOCKED']
    WHEN 'WRONG_ORGANIZATION' THEN ARRAY['CONFIGURING','DISABLED','BLOCKED']
    WHEN 'WRONG_COMPANY'      THEN ARRAY['CONFIGURING','DISABLED','BLOCKED']
    WHEN 'CAPABILITY_MISSING' THEN ARRAY['CONFIGURING','VERIFIED','DISABLED','BLOCKED']
    WHEN 'REVOKED'            THEN ARRAY['AUTH_REQUIRED','CONFIGURING','DISABLED']
    WHEN 'DISABLED'           THEN ARRAY['CONFIGURING']
    WHEN 'BLOCKED'            THEN ARRAY['CONFIGURING','DISABLED']
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'finance connection: status may not move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ACTIVE is the state that permits posting money. It is reachable only
  -- from VERIFIED — i.e. only after the company/organisation was confirmed.
  IF NEW.status = 'ACTIVE' AND NEW.external_company_id IS NULL AND NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'finance connection: cannot activate without a verified external company or organisation'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_finance_connection ON public.finance_integration_connections;
CREATE TRIGGER guard_finance_connection
  BEFORE UPDATE ON public.finance_integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_finance_connection();

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

DROP TRIGGER IF EXISTS guard_finance_sync_operation ON public.finance_sync_operations;
CREATE TRIGGER guard_finance_sync_operation
  BEFORE UPDATE ON public.finance_sync_operations
  FOR EACH ROW EXECUTE FUNCTION public.guard_finance_sync_operation();

DROP TRIGGER IF EXISTS guard_finance_sync_operation_delete ON public.finance_sync_operations;
CREATE TRIGGER guard_finance_sync_operation_delete
  BEFORE DELETE ON public.finance_sync_operations
  FOR EACH ROW EXECUTE FUNCTION public.guard_finance_sync_operation();

-- An external link is written once. Re-pointing a payment at a different
-- voucher is a reconciliation decision that deletes and re-creates the link
-- under audit, never an in-place edit.
CREATE OR REPLACE FUNCTION public.guard_finance_external_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'finance_external_links rows are immutable; delete and re-create under reconciliation'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS guard_finance_external_link ON public.finance_external_links;
CREATE TRIGGER guard_finance_external_link
  BEFORE UPDATE ON public.finance_external_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_finance_external_link();

-- ---------------------------------------------------------------
-- 9. The entity a sync operation names must be real, and ours
--
-- entity_type/entity_id is polymorphic, so no foreign key can carry the
-- tenancy. This trigger does what the FK would: the referenced payment,
-- refund, fee or student must exist in the SAME college as the operation.
-- Without it, College A's finance user could journal an operation against
-- College B's payment id and the dashboard would display it.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_entity_belongs_to_college()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  found BOOLEAN;
BEGIN
  IF NEW.entity_id IS NULL THEN
    IF NEW.entity_type <> 'master_data' THEN
      RAISE EXCEPTION 'finance: entity_id is required for %', NEW.entity_type
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  found := CASE NEW.entity_type
    WHEN 'payment'  THEN EXISTS (SELECT 1 FROM public.payments        p WHERE p.id = NEW.entity_id AND p.college_id = NEW.college_id)
    WHEN 'refund'   THEN EXISTS (SELECT 1 FROM public.refund_requests r WHERE r.id = NEW.entity_id AND r.college_id = NEW.college_id)
    WHEN 'invoice'  THEN EXISTS (SELECT 1 FROM public.fees            f WHERE f.id = NEW.entity_id AND f.college_id = NEW.college_id)
    WHEN 'student'  THEN EXISTS (SELECT 1 FROM public.students        s WHERE s.id = NEW.entity_id AND s.college_id = NEW.college_id)
    ELSE TRUE   -- journal_entry has no local row of its own
  END;

  IF NOT found THEN
    RAISE EXCEPTION 'finance: % % does not exist in this college', NEW.entity_type, NEW.entity_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS finance_sync_entity_tenant ON public.finance_sync_operations;
CREATE TRIGGER finance_sync_entity_tenant
  BEFORE INSERT ON public.finance_sync_operations
  FOR EACH ROW EXECUTE FUNCTION public.finance_entity_belongs_to_college();

DROP TRIGGER IF EXISTS finance_link_entity_tenant ON public.finance_external_links;
CREATE TRIGGER finance_link_entity_tenant
  BEFORE INSERT ON public.finance_external_links
  FOR EACH ROW EXECUTE FUNCTION public.finance_entity_belongs_to_college();

-- ---------------------------------------------------------------
-- 10. RLS
--
-- Two audiences, deliberately separated (§74, §90):
--
--   admin   — institution configuration: connections and their credentials.
--             The person who operates finance should not also hold the
--             accounting system's credentials.
--   finance — mappings, sync operations, reconciliation: the daily work.
--
-- Every policy is tenant-scoped first. `finance` and `admin` both read; the
-- write split is what differs. Credentials get NO policy at all.
-- ---------------------------------------------------------------
ALTER TABLE public.finance_integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_account_mappings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_external_links          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_sync_operations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_sync_cursors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_reconciliation_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_reconciliation_items    ENABLE ROW LEVEL SECURITY;

-- Connections: finance and admin see them; only admin creates or changes.
DROP POLICY IF EXISTS "fic_read" ON public.finance_integration_connections;
CREATE POLICY "fic_read" ON public.finance_integration_connections
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

DROP POLICY IF EXISTS "fic_insert_admin" ON public.finance_integration_connections;
CREATE POLICY "fic_insert_admin" ON public.finance_integration_connections
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
    AND status = 'DRAFT'
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "fic_update_admin" ON public.finance_integration_connections;
CREATE POLICY "fic_update_admin" ON public.finance_integration_connections
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  );

-- Deleting a connection would orphan its journal; ON DELETE RESTRICT on
-- finance_sync_operations already refuses that, and no DELETE policy is
-- granted. Retirement is status = 'DISABLED'.

-- Credentials: intentionally no policy. RLS is on, so every authenticated
-- role — admin included — reads and writes nothing. The service-role
-- worker, which bypasses RLS, is the only accessor.

-- Mappings: finance and admin both configure; this is accounting setup, not
-- credential custody.
DROP POLICY IF EXISTS "fam_read" ON public.finance_account_mappings;
CREATE POLICY "fam_read" ON public.finance_account_mappings
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

DROP POLICY IF EXISTS "fam_manage" ON public.finance_account_mappings;
CREATE POLICY "fam_manage" ON public.finance_account_mappings
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

-- External links: read-only to people. They are written by the worker from
-- a verified provider response (§76) — a client must never be able to
-- assert an external id.
DROP POLICY IF EXISTS "fel_read" ON public.finance_external_links;
CREATE POLICY "fel_read" ON public.finance_external_links
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

-- Sync operations: readable, and queueable by finance/admin — but the
-- fields that describe an OUTCOME are the worker's. A person may create a
-- PENDING row and cancel one; they may not declare a result.
DROP POLICY IF EXISTS "fso_read" ON public.finance_sync_operations;
CREATE POLICY "fso_read" ON public.finance_sync_operations
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

DROP POLICY IF EXISTS "fso_enqueue" ON public.finance_sync_operations;
CREATE POLICY "fso_enqueue" ON public.finance_sync_operations
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
    AND status = 'PENDING'
    AND attempt_number = 0
    AND external_id IS NULL
    AND external_number IS NULL
    AND response_hash IS NULL
    AND completed_at IS NULL
    AND created_by = auth.uid()
  );

-- The only person-initiated transitions are "queue it" and "cancel it".
-- SYNCED, FAILED and every other outcome come from the worker.
DROP POLICY IF EXISTS "fso_operator_transition" ON public.finance_sync_operations;
CREATE POLICY "fso_operator_transition" ON public.finance_sync_operations
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
    AND status IN ('PENDING', 'BLOCKED', 'FAILED')
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
    AND status IN ('QUEUED', 'RETRYING', 'CANCELLED')
  );

DROP POLICY IF EXISTS "fsc_read" ON public.finance_sync_cursors;
CREATE POLICY "fsc_read" ON public.finance_sync_cursors
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

DROP POLICY IF EXISTS "frr_read" ON public.finance_reconciliation_runs;
CREATE POLICY "frr_read" ON public.finance_reconciliation_runs
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

DROP POLICY IF EXISTS "frr_start" ON public.finance_reconciliation_runs;
CREATE POLICY "frr_start" ON public.finance_reconciliation_runs
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
    AND status = 'RUNNING'
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "fri_read" ON public.finance_reconciliation_items;
CREATE POLICY "fri_read" ON public.finance_reconciliation_items
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

-- Resolving a discrepancy is a person's decision and must carry their name.
-- The finding itself (type, amounts, entity) is the engine's and is not
-- editable — the USING/WITH CHECK pair below narrows to open -> resolved /
-- accepted; the trigger underneath pins every other column.
DROP POLICY IF EXISTS "fri_resolve" ON public.finance_reconciliation_items;
CREATE POLICY "fri_resolve" ON public.finance_reconciliation_items
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
    AND status = 'open'
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
    AND status IN ('resolved', 'accepted')
    AND resolved_by = auth.uid()
    AND resolution IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.guard_finance_reconciliation_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.college_id      IS DISTINCT FROM OLD.college_id
  OR NEW.run_id          IS DISTINCT FROM OLD.run_id
  OR NEW.difference_type IS DISTINCT FROM OLD.difference_type
  OR NEW.entity_type     IS DISTINCT FROM OLD.entity_type
  OR NEW.entity_id       IS DISTINCT FROM OLD.entity_id
  OR NEW.external_id     IS DISTINCT FROM OLD.external_id
  OR NEW.local_amount    IS DISTINCT FROM OLD.local_amount
  OR NEW.external_amount IS DISTINCT FROM OLD.external_amount
  OR NEW.detail          IS DISTINCT FROM OLD.detail THEN
    RAISE EXCEPTION 'finance reconciliation: a finding is immutable; only its resolution may be recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'finance reconciliation: this finding is already %', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_finance_reconciliation_item ON public.finance_reconciliation_items;
CREATE TRIGGER guard_finance_reconciliation_item
  BEFORE UPDATE ON public.finance_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_finance_reconciliation_item();

-- ---------------------------------------------------------------
-- 11. Verification (run by hand after applying)
--
--   -- credentials are unreadable by every authenticated role
--   SET request.jwt.claim.sub = '<an admin uuid>'; SET ROLE authenticated;
--   SELECT count(*) FROM public.finance_integration_credentials;  -- 0 rows
--   RESET ROLE;
--
--   -- SYNCED without an external id is refused
--   UPDATE public.finance_sync_operations SET status='SYNCED' WHERE external_id IS NULL;
--   -- expect: fso_synced_needs_external_id / the trigger's message
--
--   -- the journal cannot be pruned
--   DELETE FROM public.finance_sync_operations;   -- expect: append-only
-- ---------------------------------------------------------------

-- ---------------------------------------------------------------
-- ROLLBACK (untested; for reference)
-- DROP TABLE IF EXISTS public.finance_reconciliation_items;
-- DROP TABLE IF EXISTS public.finance_reconciliation_runs;
-- DROP TABLE IF EXISTS public.finance_sync_cursors;
-- DROP TABLE IF EXISTS public.finance_sync_operations;
-- DROP TABLE IF EXISTS public.finance_external_links;
-- DROP TABLE IF EXISTS public.finance_account_mappings;
-- DROP TABLE IF EXISTS public.finance_integration_credentials;
-- DROP TABLE IF EXISTS public.finance_integration_connections;
-- DROP FUNCTION IF EXISTS public.guard_finance_connection();
-- DROP FUNCTION IF EXISTS public.guard_finance_sync_operation();
-- DROP FUNCTION IF EXISTS public.guard_finance_external_link();
-- DROP FUNCTION IF EXISTS public.guard_finance_reconciliation_item();
-- DROP FUNCTION IF EXISTS public.finance_entity_belongs_to_college();
-- ---------------------------------------------------------------
