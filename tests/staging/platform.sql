-- ============================================================
-- Supabase platform emulation, for the staging verification suite.
--
-- The repository's migrations are written against a Supabase database, so
-- they assume a platform layer that ships with the hosted product rather
-- than with PostgreSQL: the `auth` schema, `auth.users`, `auth.uid()`, and
-- the three PostgREST roles. PGlite is plain PostgreSQL, so that layer has
-- to exist before migration 001 can run at all (001's `profiles.id`
-- REFERENCES auth.users(id)).
--
-- This file is the ONLY thing hand-written in the chain. Everything after
-- it is the repository's real migration files, applied in order, unedited.
-- Keeping the boundary here — rather than hand-writing a "post-046 schema"
-- — is what makes the result evidence about the migrations themselves.
--
-- auth.uid() reads a session GUC instead of a JWT claim. That is the same
-- substitution the existing RLS suite makes, and it is the honest one:
-- PostgREST's job is to set the claim, and this file is not testing
-- PostgREST. What it preserves is the property the policies depend on —
-- that auth.uid() is per-session and cannot be set by the SQL under test,
-- because every statement runs as `authenticated`, which is not the role
-- that can SET it.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS auth;

-- Supabase's identity table. Only the columns the migrations reference.
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY,
  email TEXT,
  raw_user_meta_data JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.email', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$ LANGUAGE sql STABLE;

-- The PostgREST roles. Migrations GRANT and REVOKE on these by name.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- BYPASSRLS mirrors the hosted platform: the service key is meant to
    -- bypass RLS, which is exactly why no test scenario uses it.
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- Supabase grants ALL on public tables to anon/authenticated and relies on
-- RLS to do the actual restricting. Default privileges rather than a blanket
-- GRANT after the fact, because migrations 011/032/033/047 REVOKE on the
-- `_raw` matviews and a later GRANT would silently undo those revokes.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
