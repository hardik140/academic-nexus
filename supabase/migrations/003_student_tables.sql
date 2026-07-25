-- ============================================================
-- Migration 003: Student Tables
-- Students, Attendance, Marks, Fees, Payments
-- ============================================================

CREATE TABLE IF NOT EXISTS public.students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES public.departments(id),
  enrollment_number TEXT NOT NULL,
  batch_year INTEGER NOT NULL,
  semester INTEGER NOT NULL DEFAULT 1,
  cgpa NUMERIC(4, 2) DEFAULT 0.00,
  credits_completed INTEGER DEFAULT 0,
  credits_required INTEGER DEFAULT 160,
  admission_date DATE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'graduated', 'dropped', 'on_leave')),
  parent_name TEXT,
  parent_phone TEXT,
  parent_email TEXT,
  blood_group TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(college_id, enrollment_number)
);

CREATE TABLE IF NOT EXISTS public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'absent'
    CHECK (status IN ('present', 'absent', 'late', 'excused')),
  marked_by UUID NOT NULL REFERENCES public.profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(student_id, course_id, date)
);

CREATE TABLE IF NOT EXISTS public.marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  exam_type TEXT NOT NULL CHECK (exam_type IN ('internal_1', 'internal_2', 'midterm', 'final', 'assignment', 'lab', 'project', 'viva')),
  max_marks NUMERIC(6, 2) NOT NULL,
  obtained_marks NUMERIC(6, 2) NOT NULL,
  semester INTEGER,
  remarks TEXT,
  entered_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(student_id, course_id, exam_type)
);

CREATE TABLE IF NOT EXISTS public.fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(12, 2) NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'overdue', 'partial', 'waived', 'refunded')),
  paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  semester INTEGER,
  academic_year TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  fee_id UUID NOT NULL REFERENCES public.fees(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'netbanking', 'cheque', 'dd', 'scholarship', 'other')),
  transaction_ref TEXT,
  receipt_number TEXT,
  status TEXT NOT NULL DEFAULT 'cleared'
    CHECK (status IN ('cleared', 'pending', 'failed', 'refunded')),
  processed_by UUID REFERENCES public.profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.scholarships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('merit', 'need', 'sports', 'government', 'corporate', 'other')),
  academic_year TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  awarded_date DATE,
  expiry_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_students_college ON public.students(college_id);
CREATE INDEX IF NOT EXISTS idx_students_user ON public.students(user_id);
CREATE INDEX IF NOT EXISTS idx_students_department ON public.students(department_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON public.attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_course ON public.attendance(course_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON public.attendance(date);
CREATE INDEX IF NOT EXISTS idx_marks_student ON public.marks(student_id);
CREATE INDEX IF NOT EXISTS idx_fees_student ON public.fees(student_id);
CREATE INDEX IF NOT EXISTS idx_fees_status ON public.fees(status);
CREATE INDEX IF NOT EXISTS idx_payments_student ON public.payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_fee ON public.payments(fee_id);

-- Triggers
CREATE TRIGGER set_updated_at_students BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at_fees BEFORE UPDATE ON public.fees FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Auto-update fee status when payment is made
CREATE OR REPLACE FUNCTION public.update_fee_on_payment()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.fees
  SET
    paid_amount = paid_amount + NEW.amount,
    paid_at = CASE WHEN (paid_amount + NEW.amount) >= amount THEN now() ELSE paid_at END,
    status = CASE
      WHEN (paid_amount + NEW.amount) >= amount THEN 'paid'
      WHEN (paid_amount + NEW.amount) > 0 THEN 'partial'
      ELSE status
    END
  WHERE id = NEW.fee_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_payment_inserted
  AFTER INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_fee_on_payment();
