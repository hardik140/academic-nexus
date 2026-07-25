-- ============================================================
-- Migration 004: Hostel & Gate Pass Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hostel_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('boys', 'girls', 'co-ed')),
  warden_id UUID REFERENCES public.profiles(id),
  total_rooms INTEGER DEFAULT 0,
  floors INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hostel_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  block_id UUID NOT NULL REFERENCES public.hostel_blocks(id) ON DELETE CASCADE,
  block_name TEXT NOT NULL,
  room_number TEXT NOT NULL,
  floor INTEGER DEFAULT 1,
  capacity INTEGER NOT NULL DEFAULT 2,
  occupancy INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'double' CHECK (type IN ('single', 'double', 'triple', 'quad')),
  ac BOOLEAN DEFAULT false,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'full', 'maintenance')),
  monthly_rent NUMERIC(10, 2),
  UNIQUE(college_id, block_name, room_number)
);

CREATE TABLE IF NOT EXISTS public.hostel_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES public.hostel_rooms(id),
  allocated_date DATE NOT NULL DEFAULT CURRENT_DATE,
  vacated_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'vacated', 'transferred')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gate_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  reason TEXT,
  exit_time TIMESTAMPTZ NOT NULL,
  return_time TIMESTAMPTZ NOT NULL,
  actual_exit TIMESTAMPTZ,
  actual_return TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'active', 'returned', 'expired')),
  approved_by UUID REFERENCES public.profiles(id),
  approved_at TIMESTAMPTZ,
  parent_notified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mess_menu (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'snacks', 'dinner')),
  items TEXT[] NOT NULL DEFAULT '{}',
  calories INTEGER,
  is_vegetarian BOOLEAN DEFAULT true,
  effective_from DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hostel_rooms_college ON public.hostel_rooms(college_id);
CREATE INDEX IF NOT EXISTS idx_hostel_allocations_student ON public.hostel_allocations(student_id);
CREATE INDEX IF NOT EXISTS idx_gate_passes_student ON public.gate_passes(student_id);
CREATE INDEX IF NOT EXISTS idx_gate_passes_status ON public.gate_passes(status);
