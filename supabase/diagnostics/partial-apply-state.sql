-- Read-only. Which migrations actually finished?
SELECT
  to_regclass('public.course_offerings')                IS NOT NULL AS "046 applied",
  to_regprocedure('public.wardens_student(uuid)')       IS NOT NULL AS "047 FINISHED",
  to_regclass('public.finance_integration_connections') IS NOT NULL AS "049 applied",
  to_regclass('public.gates')                           IS NOT NULL AS "050 applied";

-- Constraint names currently held by an index with no constraint behind it.
-- Every row here is a name that will fail ADD CONSTRAINT with 42P07.
SELECT c.relname AS orphaned_index_blocking_a_constraint
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind = 'i'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conname = c.relname)
  AND c.relname IN (
    'course_enrollments_offering_student_key','attendance_offering_student_date_key',
    'marks_offering_student_exam_key','substitution_assignments_offering_date_key',
    'fees_payment_target_key','fees_student_key','payments_student_key',
    'hostel_allocations_student_key','departments_tenant_key','profiles_tenant_key',
    'students_tenant_key','courses_tenant_key','academic_years_tenant_key',
    'semesters_tenant_key','programmes_tenant_key','sections_tenant_key',
    'course_offerings_tenant_key','placement_drives_tenant_key',
    'fic_tenant_key','gate_passes_subject_key')
ORDER BY 1;
