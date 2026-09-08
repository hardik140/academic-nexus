-- ============================================================
-- Migration 040: Room Transfer workflow
--
-- Part A closes a pre-existing gap: hostel_rooms and hostel_allocations
-- have had RLS enabled with ONLY a SELECT policy since migration 006 —
-- zero INSERT/UPDATE/ALL policy exists anywhere across the prior 39
-- migrations. Under this project's default-deny RLS, any warden/admin
-- write to either table (e.g. allocating or transferring a student)
-- would silently match zero rows and do nothing, with no error surfaced
-- anywhere — the identical bug already fixed once for hostel_blocks
-- itself in migration 013, and for attendance in migration 038.
--
-- Part B adds the new room_transfer_requests table: student requests a
-- transfer with a reason, warden reviews available rooms in their own
-- block(s) and approves against a specific room, or rejects. Approval
-- vacates the old allocation and creates a new one — see
-- app/(portal)/warden/transfers/actions.ts for the full workflow.
-- ============================================================

-- ---------- Part A: write-RLS fix ----------

CREATE POLICY "hostel_rooms_staff_manage" ON public.hostel_rooms
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('warden', 'admin')
  );

CREATE POLICY "hostel_allocations_staff_manage" ON public.hostel_allocations
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('warden', 'admin')
  );

-- ---------- Part B: room_transfer_requests ----------

CREATE TABLE public.room_transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id),
  current_allocation_id UUID REFERENCES public.hostel_allocations(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  new_room_id UUID REFERENCES public.hostel_rooms(id),
  new_allocation_id UUID REFERENCES public.hostel_allocations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_room_transfer_requests_college ON public.room_transfer_requests(college_id);
CREATE INDEX idx_room_transfer_requests_student ON public.room_transfer_requests(student_id);

ALTER TABLE public.room_transfer_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room_transfer_read_own" ON public.room_transfer_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students
      WHERE students.id = room_transfer_requests.student_id
        AND students.user_id = auth.uid()
    )
  );

CREATE POLICY "room_transfer_insert_own" ON public.room_transfer_requests
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.students
      WHERE students.id = room_transfer_requests.student_id
        AND students.user_id = auth.uid()
    )
  );

-- Block ownership enforced app-side via the student's current allocation's
-- room's block_id, same split as every other staff table this session
-- (attendance_correction_requests, substitution_assignments).
CREATE POLICY "room_transfer_staff_manage" ON public.room_transfer_requests
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('warden', 'admin')
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP TABLE IF EXISTS public.room_transfer_requests;
-- DROP POLICY IF EXISTS "hostel_rooms_staff_manage" ON public.hostel_rooms;
-- DROP POLICY IF EXISTS "hostel_allocations_staff_manage" ON public.hostel_allocations;
