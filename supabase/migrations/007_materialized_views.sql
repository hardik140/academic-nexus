-- ============================================================
-- Migration 007: Materialized Views for Analytics
-- Director & Admin dashboards load from pre-computed aggregates
-- ============================================================

-- Attendance summary per course per department
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_attendance_summary AS
SELECT
  a.college_id,
  s.department_id,
  a.course_id,
  c.name AS course_name,
  c.code AS course_code,
  COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
  COUNT(*) FILTER (WHERE a.status = 'late') AS late_count,
  COUNT(*) FILTER (WHERE a.status = 'absent') AS absent_count,
  COUNT(*) AS total_count,
  ROUND(
    COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::NUMERIC / NULLIF(COUNT(*), 0) * 100,
    1
  ) AS attendance_pct
FROM public.attendance a
JOIN public.students s ON a.student_id = s.id
JOIN public.courses c ON a.course_id = c.id
GROUP BY a.college_id, s.department_id, a.course_id, c.name, c.code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_attendance_summary
  ON public.mv_attendance_summary(college_id, department_id, course_id);

-- Fee collection summary per college
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_fee_summary AS
SELECT
  f.college_id,
  SUM(f.amount) AS total_billed,
  SUM(f.paid_amount) AS total_collected,
  SUM(f.amount - f.paid_amount) FILTER (WHERE f.status = 'overdue') AS total_overdue,
  COUNT(*) AS total_invoices,
  COUNT(*) FILTER (WHERE f.status = 'paid') AS paid_invoices,
  COUNT(*) FILTER (WHERE f.status = 'overdue') AS overdue_invoices,
  ROUND(
    SUM(f.paid_amount)::NUMERIC / NULLIF(SUM(f.amount), 0) * 100,
    1
  ) AS collection_pct
FROM public.fees f
GROUP BY f.college_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fee_summary
  ON public.mv_fee_summary(college_id);

-- Department-wise enrollment summary
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_department_enrollment AS
SELECT
  s.college_id,
  s.department_id,
  d.name AS department_name,
  d.code AS department_code,
  COUNT(*) AS total_students,
  COUNT(*) FILTER (WHERE s.status = 'active') AS active_students,
  ROUND(AVG(s.cgpa), 2) AS avg_cgpa,
  ROUND(AVG(s.credits_completed), 0) AS avg_credits
FROM public.students s
JOIN public.departments d ON s.department_id = d.id
GROUP BY s.college_id, s.department_id, d.name, d.code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_department_enrollment
  ON public.mv_department_enrollment(college_id, department_id);

-- Placement summary
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_placement_summary AS
SELECT
  p.college_id,
  COUNT(DISTINCT p.student_id) AS total_placed,
  COUNT(DISTINCT p.company_name) AS total_companies,
  ROUND(AVG(p.package_lpa), 2) AS avg_package,
  MAX(p.package_lpa) AS max_package,
  MIN(p.package_lpa) AS min_package
FROM public.placements p
WHERE p.status IN ('placed', 'joined')
GROUP BY p.college_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_placement_summary
  ON public.mv_placement_summary(college_id);

-- ============================================================
-- Function to refresh all materialized views
-- Called by Edge Function on a schedule (hourly)
-- ============================================================
CREATE OR REPLACE FUNCTION public.refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_attendance_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fee_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_enrollment;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_summary;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
