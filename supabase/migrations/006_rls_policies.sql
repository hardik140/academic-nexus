-- ============================================================
-- Migration 006: Row-Level Security Policies
-- Multi-tenant isolation + role-based access
-- ============================================================

-- Enable RLS on ALL tables
ALTER TABLE public.colleges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semesters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scholarships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hostel_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hostel_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hostel_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mess_menu ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_issued ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.placements ENABLE ROW LEVEL SECURITY;

-- ─── Helper function: get current user's college_id ───
CREATE OR REPLACE FUNCTION public.get_my_college_id()
RETURNS UUID AS $$
  SELECT college_id FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ─── Helper function: get current user's role ───
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ================================================================
-- COLLEGES: Only see your own college
-- ================================================================
CREATE POLICY "colleges_read" ON public.colleges
  FOR SELECT USING (id = public.get_my_college_id());

-- ================================================================
-- PROFILES: College-scoped reads, self-update
-- ================================================================
CREATE POLICY "profiles_read_same_college" ON public.profiles
  FOR SELECT USING (college_id = public.get_my_college_id());

CREATE POLICY "profiles_update_self" ON public.profiles
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_admin_manage" ON public.profiles
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  );

-- ================================================================
-- DEPARTMENTS: College-scoped
-- ================================================================
CREATE POLICY "departments_read" ON public.departments
  FOR SELECT USING (college_id = public.get_my_college_id());

CREATE POLICY "departments_admin" ON public.departments
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

-- ================================================================
-- COURSES: College-scoped reads
-- ================================================================
CREATE POLICY "courses_read" ON public.courses
  FOR SELECT USING (college_id = public.get_my_college_id());

CREATE POLICY "courses_manage" ON public.courses
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'hod', 'director')
  );

-- ================================================================
-- STUDENTS: Self read + admin/teacher access
-- ================================================================
CREATE POLICY "students_read_self" ON public.students
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "students_read_staff" ON public.students
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'hod', 'finance', 'director', 'admin', 'warden')
  );

CREATE POLICY "students_admin_manage" ON public.students
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  );

-- ================================================================
-- ATTENDANCE: Students read own, teachers mark
-- ================================================================
CREATE POLICY "attendance_read_student" ON public.attendance
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

CREATE POLICY "attendance_read_staff" ON public.attendance
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin')
  );

CREATE POLICY "attendance_teacher_mark" ON public.attendance
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'admin')
  );

CREATE POLICY "attendance_teacher_update" ON public.attendance
  FOR UPDATE USING (
    marked_by = auth.uid()
    OR public.get_my_role() = 'admin'
  );

-- ================================================================
-- FEES: Students read own, finance manages
-- ================================================================
CREATE POLICY "fees_read_student" ON public.fees
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

CREATE POLICY "fees_read_staff" ON public.fees
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'director', 'admin')
  );

CREATE POLICY "fees_finance_manage" ON public.fees
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

-- ================================================================
-- PAYMENTS: Students read own, finance manages
-- ================================================================
CREATE POLICY "payments_read_student" ON public.payments
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

CREATE POLICY "payments_finance_manage" ON public.payments
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin')
  );

-- ================================================================
-- GATE PASSES: Students manage own, wardens approve
-- ================================================================
CREATE POLICY "gate_passes_student" ON public.gate_passes
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

CREATE POLICY "gate_passes_student_create" ON public.gate_passes
  FOR INSERT WITH CHECK (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

CREATE POLICY "gate_passes_staff" ON public.gate_passes
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('warden', 'admin')
  );

-- ================================================================
-- NOTIFICATIONS: Read own, admins send to anyone
-- ================================================================
CREATE POLICY "notifications_read_own" ON public.notifications
  FOR SELECT USING (receiver_id = auth.uid());

CREATE POLICY "notifications_update_own" ON public.notifications
  FOR UPDATE USING (receiver_id = auth.uid());

CREATE POLICY "notifications_admin_send" ON public.notifications
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'teacher', 'hod', 'finance', 'director', 'warden')
  );

-- ================================================================
-- AUDIT LOGS: Admin-only read
-- ================================================================
CREATE POLICY "audit_logs_admin" ON public.audit_logs
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'admin'
  );

CREATE POLICY "audit_logs_insert" ON public.audit_logs
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
  );

-- ================================================================
-- COMPLAINTS: Self + staff read/manage
-- ================================================================
CREATE POLICY "complaints_read_own" ON public.complaints
  FOR SELECT USING (submitted_by = auth.uid());

CREATE POLICY "complaints_create" ON public.complaints
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND submitted_by = auth.uid()
  );

CREATE POLICY "complaints_staff" ON public.complaints
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'warden')
  );

-- ================================================================
-- Remaining tables: college-scoped reads
-- ================================================================
-- Semesters, timetable, events, hostel, mess, library, transport, placements
-- All follow the same pattern: college_id = get_my_college_id()

CREATE POLICY "semesters_read" ON public.semesters FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "course_enrollments_read" ON public.course_enrollments FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "timetable_read" ON public.timetable_slots FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "marks_read_student" ON public.marks FOR SELECT USING (student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid()));
CREATE POLICY "marks_read_staff" ON public.marks FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin'));
CREATE POLICY "marks_teacher_manage" ON public.marks FOR ALL USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher', 'admin'));
CREATE POLICY "scholarships_read" ON public.scholarships FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "hostel_blocks_read" ON public.hostel_blocks FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "hostel_rooms_read" ON public.hostel_rooms FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "hostel_allocations_read" ON public.hostel_allocations FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "mess_menu_read" ON public.mess_menu FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "events_read" ON public.events FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "documents_read_own" ON public.documents FOR SELECT USING (uploaded_by = auth.uid());
CREATE POLICY "documents_read_admin" ON public.documents FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() = 'admin');
CREATE POLICY "leave_requests_read" ON public.leave_requests FOR SELECT USING (requested_by = auth.uid() OR (college_id = public.get_my_college_id() AND public.get_my_role() IN ('hod', 'admin')));
CREATE POLICY "library_books_read" ON public.library_books FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "library_issued_read" ON public.library_issued FOR SELECT USING (issued_to = auth.uid() OR (college_id = public.get_my_college_id() AND public.get_my_role() = 'admin'));
CREATE POLICY "transport_routes_read" ON public.transport_routes FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "placements_read" ON public.placements FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "permissions_read" ON public.permissions FOR SELECT USING (true);
CREATE POLICY "role_permissions_read" ON public.role_permissions FOR SELECT USING (college_id = public.get_my_college_id());
