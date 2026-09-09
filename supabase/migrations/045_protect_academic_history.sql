-- ============================================================
-- Migration 045: stop one DELETE from erasing academic history
--
-- courses.department_id is ON DELETE CASCADE (migration 002), and from
-- `courses` the cascade continues into attendance, marks, course_enrollments,
-- timetable_slots and attendance_correction_requests — all CASCADE. So:
--
--   DELETE FROM departments WHERE id = '<x>';
--
-- would erase every attendance record, every mark, every enrolment and the
-- entire timetable for that department. Database cascades never call
-- lib/audit.ts's logAudit(), so audit_logs would show one department
-- deletion and nothing else — the destruction would be untraceable.
--
-- NOT CURRENTLY REACHABLE, and worth stating plainly: the application
-- exposes exactly one .delete() across its whole surface (a join-table
-- cleanup in placement-cell/drives), and students.department_id carries no
-- cascade, so the FK restricts a department delete while any student row
-- exists. This is a landmine, not a live wound — but it is one dashboard
-- click, or one future "delete department" button, away from being real.
--
-- The fix matches how this schema already thinks: both departments and
-- courses carry `status` with an 'inactive'/'archived' value, so retirement
-- has a non-destructive path already modelled. This migration makes that
-- the ONLY path for anything holding academic history.
--
-- Deliberately NOT changed:
--   - college_id CASCADEs. Deleting a tenant is meant to remove its data,
--     and that is a support operation, not an in-app one.
--   - attendance_correction_requests.attendance_id CASCADE, and
--     placement_drive_departments' CASCADEs — those are child records with
--     no independent historical meaning, and the drives one backs the single
--     legitimate .delete() in the app.
--
-- Sign-off: REQUIRED before applying. This alters foreign keys on the
-- highest-traffic academic tables; per .agent/.rules §4 it is a reviewed
-- schema change, and it should be applied in a maintenance window since each
-- ALTER takes a brief ACCESS EXCLUSIVE lock on the child table.
-- ============================================================

-- ---------------------------------------------------------------
-- courses.department_id : CASCADE -> RESTRICT
-- This is the single most important line in the file — it is the edge that
-- turns one department delete into a department-wide history wipe.
-- ---------------------------------------------------------------
ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_department_id_fkey;
ALTER TABLE public.courses
  ADD CONSTRAINT courses_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------
-- The academic-history tables hanging off courses.
-- ---------------------------------------------------------------
ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_course_id_fkey;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_course_id_fkey
  FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE RESTRICT;

ALTER TABLE public.marks
  DROP CONSTRAINT IF EXISTS marks_course_id_fkey;
ALTER TABLE public.marks
  ADD CONSTRAINT marks_course_id_fkey
  FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE RESTRICT;

ALTER TABLE public.course_enrollments
  DROP CONSTRAINT IF EXISTS course_enrollments_course_id_fkey;
ALTER TABLE public.course_enrollments
  ADD CONSTRAINT course_enrollments_course_id_fkey
  FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------
-- Student-linked history. A student row must not be deletable out from
-- under their own attendance/marks/fees either — same argument.
-- ---------------------------------------------------------------
ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_student_id_fkey;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;

ALTER TABLE public.marks
  DROP CONSTRAINT IF EXISTS marks_student_id_fkey;
ALTER TABLE public.marks
  ADD CONSTRAINT marks_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------
-- Financial history. fees/payments must never vanish with a student row —
-- a deleted payment is a deleted receipt.
-- ---------------------------------------------------------------
ALTER TABLE public.fees
  DROP CONSTRAINT IF EXISTS fees_student_id_fkey;
ALTER TABLE public.fees
  ADD CONSTRAINT fees_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_student_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_fee_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_fee_id_fkey
  FOREIGN KEY (fee_id) REFERENCES public.fees(id) ON DELETE RESTRICT;

-- ============================================================
-- Post-apply verification
-- ============================================================
-- As service role, against a throwaway department, each of these must now
-- raise 23503 (foreign_key_violation) instead of silently succeeding:
--
--   DELETE FROM public.departments WHERE id = '<dept with courses>';
--   DELETE FROM public.courses     WHERE id = '<course with attendance>';
--   DELETE FROM public.students    WHERE id = '<student with marks>';
--
-- Retiring a department/course is now exclusively:
--   UPDATE public.departments SET status = 'inactive' WHERE id = '<x>';
--   UPDATE public.courses     SET status = 'archived' WHERE id = '<x>';
--
-- NOTE: if this migration fails to apply, it is because rows already violate
-- the new constraints — that cannot happen for RESTRICT (it only constrains
-- future deletes), so a failure here means a genuinely orphaned row that
-- should be investigated rather than forced through.
--
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- Re-create each constraint above with ON DELETE CASCADE instead of
-- RESTRICT, e.g.:
--   ALTER TABLE public.courses DROP CONSTRAINT courses_department_id_fkey;
--   ALTER TABLE public.courses ADD CONSTRAINT courses_department_id_fkey
--     FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;
