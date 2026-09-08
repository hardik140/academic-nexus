-- ============================================================
-- Migration 032: mv_department_health — Department Performance Heatmap
-- ============================================================
-- New materialized view rather than altering the four existing ones —
-- avoids re-running migration 011's RLS-unsupported-on-MV rename/wrap dance
-- on views that already work. Wrapped exactly per that migration's pattern:
-- rename to _raw, revoke direct access, create a college-scoped plain VIEW
-- under the original name, grant SELECT to authenticated. Folded into the
-- existing refresh_analytics() via CREATE OR REPLACE, so
-- app/api/cron/refresh-analytics/route.ts needs zero code changes.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_department_health_raw AS
WITH dept_students AS (
  SELECT s.college_id, s.department_id, d.name AS department_name, d.code AS department_code,
         COUNT(*) AS total_students,
         ROUND(AVG(s.cgpa), 2) AS avg_cgpa
  FROM public.students s
  JOIN public.departments d ON s.department_id = d.id
  WHERE s.status = 'active'
  GROUP BY s.college_id, s.department_id, d.name, d.code
),
dept_attendance AS (
  SELECT s.department_id,
         ROUND(COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS attendance_pct
  FROM public.attendance a
  JOIN public.students s ON a.student_id = s.id
  GROUP BY s.department_id
),
dept_backlog AS (
  -- course_enrollments.student_id references profiles(id), not students(id)
  -- directly (a pre-existing schema quirk from migration 002) — join
  -- through students.user_id, which also references profiles(id).
  SELECT s.department_id,
         COUNT(*) FILTER (WHERE ce.status = 'failed') AS backlog_count,
         ROUND(COUNT(*) FILTER (WHERE ce.status = 'failed')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS backlog_rate
  FROM public.course_enrollments ce
  JOIN public.students s ON s.user_id = ce.student_id
  GROUP BY s.department_id
),
dept_fees AS (
  SELECT s.department_id,
         ROUND(SUM(f.paid_amount)::NUMERIC / NULLIF(SUM(f.amount), 0) * 100, 1) AS fee_collection_pct
  FROM public.fees f
  JOIN public.students s ON f.student_id = s.id
  GROUP BY s.department_id
),
dept_placement AS (
  SELECT s.department_id,
         ROUND(COUNT(*) FILTER (WHERE spp.placement_status = 'placed')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS placement_rate
  FROM public.student_placement_profiles spp
  JOIN public.students s ON spp.student_id = s.id
  GROUP BY s.department_id
)
SELECT
  ds.college_id,
  ds.department_id,
  ds.department_name,
  ds.department_code,
  ds.total_students,
  ds.avg_cgpa,
  da.attendance_pct,
  COALESCE(db.backlog_count, 0) AS backlog_count,
  db.backlog_rate,
  df.fee_collection_pct,
  dp.placement_rate
FROM dept_students ds
LEFT JOIN dept_attendance da ON da.department_id = ds.department_id
LEFT JOIN dept_backlog db ON db.department_id = ds.department_id
LEFT JOIN dept_fees df ON df.department_id = ds.department_id
LEFT JOIN dept_placement dp ON dp.department_id = ds.department_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_department_health ON public.mv_department_health_raw(college_id, department_id);

REVOKE ALL ON public.mv_department_health_raw FROM anon, authenticated;

CREATE VIEW public.mv_department_health AS
  SELECT * FROM public.mv_department_health_raw
  WHERE college_id = public.get_my_college_id();

GRANT SELECT ON public.mv_department_health TO authenticated;

CREATE OR REPLACE FUNCTION public.refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_attendance_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fee_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_enrollment_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_health_raw;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

SELECT public.refresh_analytics();
