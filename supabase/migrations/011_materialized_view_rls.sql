-- ============================================================
-- Migration 011: Materialized view access control + one-time refresh
--
-- mv_department_enrollment, mv_attendance_summary, mv_fee_summary, and
-- mv_placement_summary (migration 007) were created with no access
-- control at all. Confirmed empirically: a plain fetch using only the
-- public anon key, no authentication, returns HTTP 200 (not 401/403)
-- for all four — they are openly exposed via PostgREST. Also confirmed
-- all four are completely empty (even via service_role) — refresh_analytics()
-- (also defined in migration 007) has apparently never been called.
--
-- CORRECTION: the first version of this migration tried
-- `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY`, which
-- Postgres rejects outright — RLS is not supported on materialized
-- views, full stop (error 42809). That attempt never applied (it was
-- the first statement in the batch, so the whole script rolled back).
--
-- Real fix: materialized views can't have RLS, so this renames each
-- raw materialized view (suffix _raw), revokes direct anon/authenticated
-- access to the renamed relations, and creates a college-scoped regular
-- VIEW under the *original* name that filters by college_id. Regular
-- views work fine here because they run with the view owner's
-- privileges by default (not RLS, just a WHERE clause + revoked access
-- to the thing underneath) — no application code needs to change, since
-- queries still hit "mv_department_enrollment" etc. by the same name.
--
-- refresh_analytics() is redefined to target the renamed _raw relations.
--
-- Sign-off: approved as part of the HOD Portal Stitch Redesign + Real
-- DB/API Fixes pass (see C:\Users\91981\.claude\plans\crystalline-dancing-floyd.md).
-- ============================================================

ALTER MATERIALIZED VIEW public.mv_department_enrollment RENAME TO mv_department_enrollment_raw;
ALTER MATERIALIZED VIEW public.mv_attendance_summary RENAME TO mv_attendance_summary_raw;
ALTER MATERIALIZED VIEW public.mv_fee_summary RENAME TO mv_fee_summary_raw;
ALTER MATERIALIZED VIEW public.mv_placement_summary RENAME TO mv_placement_summary_raw;

REVOKE ALL ON public.mv_department_enrollment_raw FROM anon, authenticated;
REVOKE ALL ON public.mv_attendance_summary_raw FROM anon, authenticated;
REVOKE ALL ON public.mv_fee_summary_raw FROM anon, authenticated;
REVOKE ALL ON public.mv_placement_summary_raw FROM anon, authenticated;

CREATE VIEW public.mv_department_enrollment AS
  SELECT * FROM public.mv_department_enrollment_raw
  WHERE college_id = public.get_my_college_id();

CREATE VIEW public.mv_attendance_summary AS
  SELECT * FROM public.mv_attendance_summary_raw
  WHERE college_id = public.get_my_college_id();

CREATE VIEW public.mv_fee_summary AS
  SELECT * FROM public.mv_fee_summary_raw
  WHERE college_id = public.get_my_college_id();

CREATE VIEW public.mv_placement_summary AS
  SELECT * FROM public.mv_placement_summary_raw
  WHERE college_id = public.get_my_college_id();

GRANT SELECT ON public.mv_department_enrollment TO authenticated;
GRANT SELECT ON public.mv_attendance_summary TO authenticated;
GRANT SELECT ON public.mv_fee_summary TO authenticated;
GRANT SELECT ON public.mv_placement_summary TO authenticated;

CREATE OR REPLACE FUNCTION public.refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_attendance_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fee_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_enrollment_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_summary_raw;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- One-time population so reporting screens aren't empty immediately
-- after this migration. Will go stale again without a scheduled
-- refresh_analytics() call — ongoing auto-refresh (pg_cron or a
-- scheduled Edge Function) is a separate infra decision, not attempted here.
SELECT public.refresh_analytics();

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP VIEW IF EXISTS public.mv_department_enrollment;
-- DROP VIEW IF EXISTS public.mv_attendance_summary;
-- DROP VIEW IF EXISTS public.mv_fee_summary;
-- DROP VIEW IF EXISTS public.mv_placement_summary;
-- ALTER MATERIALIZED VIEW public.mv_department_enrollment_raw RENAME TO mv_department_enrollment;
-- ALTER MATERIALIZED VIEW public.mv_attendance_summary_raw RENAME TO mv_attendance_summary;
-- ALTER MATERIALIZED VIEW public.mv_fee_summary_raw RENAME TO mv_fee_summary;
-- ALTER MATERIALIZED VIEW public.mv_placement_summary_raw RENAME TO mv_placement_summary;
-- GRANT SELECT ON public.mv_department_enrollment TO anon, authenticated;
-- GRANT SELECT ON public.mv_attendance_summary TO anon, authenticated;
-- GRANT SELECT ON public.mv_fee_summary TO anon, authenticated;
-- GRANT SELECT ON public.mv_placement_summary TO anon, authenticated;
-- CREATE OR REPLACE FUNCTION public.refresh_analytics()
-- RETURNS void AS $$
-- BEGIN
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_attendance_summary;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fee_summary;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_enrollment;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_summary;
-- END;
-- $$ LANGUAGE plpgsql SECURITY DEFINER;
