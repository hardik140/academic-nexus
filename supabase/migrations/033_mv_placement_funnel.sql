-- ============================================================
-- Migration 033: mv_placement_funnel — Placement Command Center
-- ============================================================
-- Sourced from student_placement_profiles.placement_status, the real
-- per-student pipeline state — mv_placement_summary (migration 007) only
-- rolls up the legacy flat `placements` outcomes table, never the funnel
-- tables, so it can't answer "how many are shortlisted right now." Same
-- wrap-view pattern as migration 032. Per-drive funnel detail
-- (placement_applications.status for one specific drive) is queried live
-- elsewhere — drive-scoped row counts are naturally small, no MV needed.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_placement_funnel_raw AS
SELECT
  s.college_id,
  s.department_id,
  d.name AS department_name,
  d.code AS department_code,
  COUNT(*) AS total_students,
  COUNT(*) FILTER (WHERE spp.placement_status IS NULL OR spp.placement_status = 'not_placed') AS not_placed_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'eligible') AS eligible_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'applied') AS applied_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'shortlisted') AS shortlisted_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'selected') AS selected_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'placed') AS placed_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'rejected') AS rejected_count,
  COUNT(*) FILTER (WHERE spp.placement_status = 'opted_out') AS opted_out_count
FROM public.students s
JOIN public.departments d ON s.department_id = d.id
LEFT JOIN public.student_placement_profiles spp ON spp.student_id = s.id
WHERE s.status = 'active'
GROUP BY s.college_id, s.department_id, d.name, d.code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_placement_funnel ON public.mv_placement_funnel_raw(college_id, department_id);

REVOKE ALL ON public.mv_placement_funnel_raw FROM anon, authenticated;

CREATE VIEW public.mv_placement_funnel AS
  SELECT * FROM public.mv_placement_funnel_raw
  WHERE college_id = public.get_my_college_id();

GRANT SELECT ON public.mv_placement_funnel TO authenticated;

CREATE OR REPLACE FUNCTION public.refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_attendance_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fee_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_enrollment_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_health_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_funnel_raw;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

SELECT public.refresh_analytics();
