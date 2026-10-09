-- 059: business reads computed in PostgreSQL, not from a capped page of rows.
--
-- Redis transformation Phase 3. PostgREST returns at most `max_rows` rows
-- (1,000 by default on Supabase) to a select with no range, and says
-- nothing. Every read below used to fetch rows and count, sum or filter them
-- in JavaScript, so past that many rows its answer was silently wrong. Each
-- is now one statement that returns a small, complete result.
--
-- SECURITY. Every function is SECURITY INVOKER unless stated otherwise: RLS
-- decides which rows count, exactly as it decided which rows the old select
-- returned, and each takes the caller's college explicitly as well. Every
-- function is revoked from PUBLIC and anon. The one SECURITY DEFINER function
-- (notification_push_tokens) explains why below.
--
-- ROLLBACK: drop the functions and the notifications.announcement_id column
-- (nothing reads either outside the code that calls them).

-- ─────────────────────────────────────────────────────────────
-- Shared: the effective fee status, exactly lib/finance-status.ts
-- computeEffectiveFeeStatus (057 inlines the same rule; parity-tested).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fee_effective_status(p_amount NUMERIC, p_paid NUMERIC, p_status TEXT, p_due DATE)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN p_status IN ('paid', 'waived', 'refunded') THEN p_status
    WHEN p_amount - p_paid > 0 AND p_due < (now() AT TIME ZONE 'UTC')::date THEN 'overdue'
    ELSE p_status
  END;
$$;
REVOKE ALL ON FUNCTION public.fee_effective_status(NUMERIC, NUMERIC, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fee_effective_status(NUMERIC, NUMERIC, TEXT, DATE) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- 1. Student risk overview (director/attention getStudentRiskOverview)
--
-- Per department: active students, those with at least one risk factor
-- (CGPA < 5, an overdue fee, a failed enrolment) and those with two or more.
-- Enrolments reference students(id) since 047; the old code mapped them
-- through user_id and so never counted a backlog — fixed here.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.student_risk_overview(p_college_id UUID, p_department_id UUID DEFAULT NULL)
RETURNS TABLE (
  department_id UUID,
  department_name TEXT,
  department_code TEXT,
  total_students BIGINT,
  at_risk BIGINT,
  critical BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH s AS (
    SELECT st.id, st.department_id, st.cgpa
    FROM public.students st
    WHERE st.college_id = p_college_id
      AND st.status = 'active'
      AND (p_department_id IS NULL OR st.department_id = p_department_id)
  ),
  overdue AS (
    SELECT DISTINCT f.student_id
    FROM public.fees f
    WHERE f.college_id = p_college_id
      AND public.fee_effective_status(f.amount, f.paid_amount, f.status, f.due_date) = 'overdue'
  ),
  backlog AS (
    SELECT DISTINCT e.student_id
    FROM public.course_enrollments e
    WHERE e.college_id = p_college_id AND e.status = 'failed'
  ),
  scored AS (
    SELECT s.department_id,
           (CASE WHEN s.cgpa IS NOT NULL AND s.cgpa < 5 THEN 1 ELSE 0 END)
         + (CASE WHEN o.student_id IS NOT NULL THEN 1 ELSE 0 END)
         + (CASE WHEN b.student_id IS NOT NULL THEN 1 ELSE 0 END) AS factors
    FROM s
    LEFT JOIN overdue o ON o.student_id = s.id
    LEFT JOIN backlog b ON b.student_id = s.id
  )
  SELECT sc.department_id,
         COALESCE(d.name, 'Unknown'),
         COALESCE(d.code, ''),
         count(*),
         count(*) FILTER (WHERE sc.factors >= 1),
         count(*) FILTER (WHERE sc.factors >= 2)
  FROM scored sc
  LEFT JOIN public.departments d ON d.id = sc.department_id
  GROUP BY sc.department_id, d.name, d.code
  ORDER BY COALESCE(d.name, 'Unknown');
$$;
REVOKE ALL ON FUNCTION public.student_risk_overview(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_risk_overview(UUID, UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2. Faculty activity (director/faculty listFaculty; hod/faculty workload)
--
-- For the given faculty: offerings delivered (not cancelled), weekly periods
-- of those offerings, distinct days attendance was marked, marks entered.
-- The old code capped offerings and slots at 1,000 rows each and read every
-- attendance and marks row of the page's faculty.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.faculty_activity(p_college_id UUID, p_faculty_ids UUID[])
RETURNS TABLE (
  faculty_id UUID,
  course_count BIGINT,
  weekly_periods BIGINT,
  attendance_sessions_marked BIGINT,
  marks_entered BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH f AS (SELECT DISTINCT unnest(p_faculty_ids) AS id),
  o AS (
    SELECT co.id, co.instructor_id
    FROM public.course_offerings co
    WHERE co.college_id = p_college_id
      AND co.instructor_id = ANY (p_faculty_ids)
      AND co.status <> 'cancelled'
  )
  SELECT f.id,
         (SELECT count(*) FROM o WHERE o.instructor_id = f.id),
         (SELECT count(*) FROM public.timetable_slots ts JOIN o ON o.id = ts.offering_id WHERE o.instructor_id = f.id),
         (SELECT count(DISTINCT a.date) FROM public.attendance a WHERE a.college_id = p_college_id AND a.marked_by = f.id),
         (SELECT count(*) FROM public.marks m WHERE m.college_id = p_college_id AND m.entered_by = f.id)
  FROM f;
$$;
REVOKE ALL ON FUNCTION public.faculty_activity(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.faculty_activity(UUID, UUID[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 3. Finance reports (finance/reports page)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fee_department_breakdown(p_college_id UUID)
RETURNS TABLE (department_name TEXT, department_code TEXT, billed NUMERIC, collected NUMERIC)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT d.name, d.code, COALESCE(sum(f.amount), 0), COALESCE(sum(f.paid_amount), 0)
  FROM public.fees f
  JOIN public.students st ON st.id = f.student_id
  JOIN public.departments d ON d.id = st.department_id
  WHERE f.college_id = p_college_id
  GROUP BY d.name, d.code
  ORDER BY d.code;
$$;
REVOKE ALL ON FUNCTION public.fee_department_breakdown(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fee_department_breakdown(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.fee_status_breakdown(p_college_id UUID)
RETURNS TABLE (effective_status TEXT, fee_count BIGINT, outstanding NUMERIC)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT public.fee_effective_status(f.amount, f.paid_amount, f.status, f.due_date),
         count(*),
         COALESCE(sum(f.amount - f.paid_amount), 0)
  FROM public.fees f
  WHERE f.college_id = p_college_id
  GROUP BY 1
  ORDER BY 1;
$$;
REVOKE ALL ON FUNCTION public.fee_status_breakdown(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fee_status_breakdown(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4. Finance exceptions (finance/exceptions getFinanceExceptions)
--
-- Every category is computed over ALL rows (duplicates and overpayments are
-- sums and groupings, so a missing row changes them); each returns at most
-- p_limit entries, and category_total says how many there are in all.
-- Duplicate payment risk is lib/finance-status.ts detectDuplicatePaymentRisk:
-- cleared payments with the same student, fee, amount and UTC day.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_exceptions(p_college_id UUID, p_limit INTEGER DEFAULT 200)
RETURNS TABLE (
  category TEXT,
  item_id TEXT,
  student_name TEXT,
  enrollment_number TEXT,
  amount NUMERIC,
  detail TEXT,
  category_total BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH lbl AS (
    SELECT st.id AS student_id, COALESCE(p.full_name, 'Unknown') AS name, COALESCE(st.enrollment_number, '—') AS enrollment
    FROM public.students st
    LEFT JOIN public.profiles p ON p.id = st.user_id
    WHERE st.college_id = p_college_id
  ),
  overdue AS (
    SELECT f.id::text AS item_id, f.student_id, f.amount - f.paid_amount AS amount, 'Due ' || f.due_date::text AS detail, f.due_date AS sort_key
    FROM public.fees f
    WHERE f.college_id = p_college_id
      AND public.fee_effective_status(f.amount, f.paid_amount, f.status, f.due_date) = 'overdue'
  ),
  dup AS (
    SELECT p.student_id, p.fee_id, p.amount, (p.created_at AT TIME ZONE 'UTC')::date AS pay_day, count(*) AS n
    FROM public.payments p
    WHERE p.college_id = p_college_id AND p.status = 'cleared'
    GROUP BY p.student_id, p.fee_id, p.amount, (p.created_at AT TIME ZONE 'UTC')::date
    HAVING count(*) > 1
  ),
  overpaid AS (
    SELECT f.id::text AS item_id, f.student_id, s.paid - f.amount AS amount,
           'Paid ' || to_char(s.paid, 'FM999999999990.00') || ' against a ' || to_char(f.amount, 'FM999999999990.00') || ' fee' AS detail
    FROM (
      SELECT p.fee_id, sum(p.amount) AS paid
      FROM public.payments p
      WHERE p.college_id = p_college_id AND p.status = 'cleared'
      GROUP BY p.fee_id
    ) s
    JOIN public.fees f ON f.id = s.fee_id AND f.college_id = p_college_id
    WHERE s.paid > f.amount
  ),
  ref AS (
    SELECT r.id::text AS item_id, r.student_id, r.amount, r.reason AS detail, r.created_at
    FROM public.refund_requests r
    WHERE r.college_id = p_college_id AND r.status = 'pending'
  ),
  disp AS (
    SELECT d.id::text AS item_id, d.student_id, 0::numeric AS amount, d.description AS detail, d.created_at
    FROM public.financial_disputes d
    WHERE d.college_id = p_college_id AND d.status IN ('submitted', 'under_investigation')
  ),
  items AS (
    (SELECT 'overdueFees' AS category, o.item_id, o.student_id, o.amount, o.detail,
            (SELECT count(*) FROM overdue) AS total
     FROM overdue o ORDER BY o.sort_key, o.item_id LIMIT p_limit)
    UNION ALL
    (SELECT 'duplicatePayments', 'dup-' || (row_number() OVER (ORDER BY d.pay_day DESC, d.student_id, d.fee_id) - 1)::text,
            d.student_id, d.amount, d.n::text || ' payments of the same amount on ' || d.pay_day::text,
            (SELECT count(*) FROM dup)
     FROM dup d ORDER BY d.pay_day DESC, d.student_id, d.fee_id LIMIT p_limit)
    UNION ALL
    (SELECT 'overpayments', o.item_id, o.student_id, o.amount, o.detail, (SELECT count(*) FROM overpaid)
     FROM overpaid o ORDER BY o.amount DESC, o.item_id LIMIT p_limit)
    UNION ALL
    (SELECT 'refundsAwaitingApproval', r.item_id, r.student_id, r.amount, r.detail, (SELECT count(*) FROM ref)
     FROM ref r ORDER BY r.created_at, r.item_id LIMIT p_limit)
    UNION ALL
    (SELECT 'disputesNeedingAttention', d.item_id, d.student_id, d.amount, d.detail, (SELECT count(*) FROM disp)
     FROM disp d ORDER BY d.created_at, d.item_id LIMIT p_limit)
  )
  SELECT r.category, r.item_id, COALESCE(l.name, 'Unknown'), COALESCE(l.enrollment, '—'), r.amount, r.detail, r.total
  FROM items r
  LEFT JOIN lbl l ON l.student_id = r.student_id;
$$;
REVOKE ALL ON FUNCTION public.finance_exceptions(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_exceptions(UUID, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. Placement reports (placement-cell/reports getPlacementReports)
--
-- Placed and joined placements, grouped. The department and batch year come
-- through students, which RLS shows to some roles and not others (exactly as
-- the old embedded join did): an unreadable student counts as "Unknown".
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.placement_report(p_college_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH pl AS (
    SELECT pl.company_name, COALESCE(pl.package_lpa, 0) AS pkg, st.batch_year, d.name AS dept
    FROM public.placements pl
    LEFT JOIN public.students st ON st.id = pl.student_id
    LEFT JOIN public.departments d ON d.id = st.department_id
    WHERE pl.college_id = p_college_id AND pl.status IN ('placed', 'joined')
  )
  SELECT jsonb_build_object(
    'totalPlaced', (SELECT count(*) FROM pl),
    'byDepartment', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'count', n) ORDER BY n DESC, name)
                              FROM (SELECT COALESCE(dept, 'Unknown') AS name, count(*) AS n FROM pl GROUP BY 1) x), '[]'::jsonb),
    'byCompany', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'count', n) ORDER BY n DESC, name)
                           FROM (SELECT company_name AS name, count(*) AS n FROM pl GROUP BY 1) x), '[]'::jsonb),
    'byYear', COALESCE((SELECT jsonb_agg(jsonb_build_object('year', batch_year::text, 'count', n) ORDER BY batch_year)
                        FROM (SELECT batch_year, count(*) AS n FROM pl WHERE batch_year IS NOT NULL GROUP BY 1) x), '[]'::jsonb),
    'packageDistribution', jsonb_build_array(
      jsonb_build_object('range', '< ₹5L', 'count', (SELECT count(*) FROM pl WHERE pkg < 5)),
      jsonb_build_object('range', '₹5–10L', 'count', (SELECT count(*) FROM pl WHERE pkg >= 5 AND pkg < 10)),
      jsonb_build_object('range', '₹10–15L', 'count', (SELECT count(*) FROM pl WHERE pkg >= 10 AND pkg < 15)),
      jsonb_build_object('range', '₹15L+', 'count', (SELECT count(*) FROM pl WHERE pkg >= 15))
    )
  );
$$;
REVOKE ALL ON FUNCTION public.placement_report(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.placement_report(UUID) TO authenticated;

-- Applications per drive and status (director/placements/funnel).
CREATE OR REPLACE FUNCTION public.placement_drive_funnel(p_college_id UUID, p_drive_ids UUID[])
RETURNS TABLE (drive_id UUID, applied BIGINT, shortlisted BIGINT, interview BIGINT, selected BIGINT, rejected BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT d.id,
         count(a.*),
         count(a.*) FILTER (WHERE a.status = 'shortlisted'),
         count(a.*) FILTER (WHERE a.status = 'interview'),
         count(a.*) FILTER (WHERE a.status = 'selected'),
         count(a.*) FILTER (WHERE a.status = 'rejected')
  FROM public.placement_drives d
  LEFT JOIN public.placement_applications a ON a.drive_id = d.id
  WHERE d.college_id = p_college_id AND d.id = ANY (p_drive_ids)
  GROUP BY d.id;
$$;
REVOKE ALL ON FUNCTION public.placement_drive_funnel(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.placement_drive_funnel(UUID, UUID[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 6. Hostel capacity per block (director hostel rollup, forecast, goals)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hostel_block_capacity(p_college_id UUID)
RETURNS TABLE (block_id UUID, capacity BIGINT, occupancy BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT r.block_id, COALESCE(sum(r.capacity), 0)::bigint, COALESCE(sum(r.occupancy), 0)::bigint
  FROM public.hostel_rooms r
  WHERE r.college_id = p_college_id
  GROUP BY r.block_id;
$$;
REVOKE ALL ON FUNCTION public.hostel_block_capacity(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hostel_block_capacity(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 7. Gate security overview (director/security securityOverview)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gate_security_counts(p_college_id UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (
  exits_today BIGINT,
  returns_today BIGINT,
  currently_outside BIGINT,
  overdue BIGINT,
  pending_passes BIGINT,
  rejected_scans BIGINT,
  invalid_qr_attempts BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT
    (SELECT count(*) FROM public.gate_movements m WHERE m.college_id = p_college_id AND m.occurred_at >= p_since AND m.movement_type = 'OUT'),
    (SELECT count(*) FROM public.gate_movements m WHERE m.college_id = p_college_id AND m.occurred_at >= p_since AND m.movement_type = 'IN'),
    (SELECT count(*) FROM public.gate_passes g WHERE g.college_id = p_college_id AND g.status = 'active'),
    (SELECT count(*) FROM public.gate_passes g WHERE g.college_id = p_college_id AND g.status = 'active' AND g.return_time < now()),
    (SELECT count(*) FROM public.gate_passes g WHERE g.college_id = p_college_id AND g.status = 'pending'),
    (SELECT count(*) FROM public.audit_logs a WHERE a.college_id = p_college_id AND a.table_name = 'gate_movements'
       AND a.created_at >= p_since AND a.action LIKE 'gate\_scan\_%'),
    (SELECT count(*) FROM public.audit_logs a WHERE a.college_id = p_college_id AND a.table_name = 'gate_movements'
       AND a.created_at >= p_since
       AND a.action IN ('gate_scan_invalid_qr', 'gate_scan_bad_signature', 'gate_scan_unparseable',
                        'gate_scan_unknown_credential', 'gate_scan_cross_college'));
$$;
REVOKE ALL ON FUNCTION public.gate_security_counts(UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gate_security_counts(UUID, TIMESTAMPTZ) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 8. A student's attendance per class, over every record (student/attendance)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.attendance_summary(p_student_id UUID)
RETURNS TABLE (offering_id UUID, present BIGINT, total BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT a.offering_id,
         count(*) FILTER (WHERE a.status IN ('present', 'late')),
         count(*)
  FROM public.attendance a
  WHERE a.student_id = p_student_id
  GROUP BY a.offering_id;
$$;
REVOKE ALL ON FUNCTION public.attendance_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attendance_summary(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 9. Finance mapping usage (lib/finance/mapping validateMappings)
-- Every fee head and payment method in use, with how many records use it.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_mapping_usage(p_college_id UUID)
RETURNS TABLE (kind TEXT, local_key TEXT, record_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT 'fee_head', f.type, count(*) FROM public.fees f WHERE f.college_id = p_college_id GROUP BY f.type
  UNION ALL
  SELECT 'payment_method', p.method, count(*) FROM public.payments p WHERE p.college_id = p_college_id GROUP BY p.method;
$$;
REVOKE ALL ON FUNCTION public.finance_mapping_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_mapping_usage(UUID) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- 10. Student search (invoice, scholarship and placement-record pickers)
--
-- The pickers listed every student and so offered only the first 1,000. A
-- bounded search instead; RLS decides who can be found.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_students(p_query TEXT, p_limit INTEGER DEFAULT 25)
RETURNS TABLE (id UUID, enrollment_number TEXT, full_name TEXT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT st.id, st.enrollment_number, p.full_name
  FROM public.students st
  LEFT JOIN public.profiles p ON p.id = st.user_id
  WHERE length(btrim(COALESCE(p_query, ''))) >= 1
    AND (st.enrollment_number ILIKE '%' || btrim(p_query) || '%'
         OR p.full_name ILIKE '%' || btrim(p_query) || '%')
  ORDER BY st.enrollment_number
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 50);
$$;
REVOKE ALL ON FUNCTION public.search_students(TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_students(TEXT, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 11. Announcement fan-out, in one statement
--
-- The director's announcement and the placement cell's notification each
-- selected every recipient (capped at 1,000), then inserted one row per
-- recipient from the application. Now the recipients are selected and the
-- rows written by ONE INSERT … SELECT: no recipient list crosses the wire,
-- nothing is capped, and the statement is atomic — all rows or none, so a
-- failure leaves nothing half-sent.
--
-- Every row of one send shares an announcement_id, which is how the push
-- step finds that send's recipients (12).
--
-- SECURITY INVOKER: notifications_admin_send (047) still decides who may
-- send (college = mine, role, sender = me), and RLS on profiles/students
-- decides who can be reached.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS announcement_id UUID;
CREATE INDEX IF NOT EXISTS idx_notifications_announcement ON public.notifications (announcement_id) WHERE announcement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.send_announcement(
  p_college_id UUID,
  p_title TEXT,
  p_message TEXT,
  p_audience TEXT
)
RETURNS TABLE (announcement_id UUID, recipient_count INTEGER)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
  v_n INTEGER;
BEGIN
  -- The same gate as the Server Action (requireRole director/admin), here
  -- too: authenticated users can call any granted function over PostgREST
  -- directly, and notifications_admin_send alone would let a teacher
  -- message the whole college through this function.
  IF p_college_id IS DISTINCT FROM public.get_my_college_id()
     OR public.get_my_role() NOT IN ('director', 'admin') THEN
    RAISE EXCEPTION 'announcement: only a director or admin may announce, and only to their own college' USING ERRCODE = '42501';
  END IF;
  IF p_audience NOT IN ('all', 'staff', 'students') THEN
    RAISE EXCEPTION 'announcement: unknown audience %', p_audience USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.notifications (college_id, title, message, receiver_id, sender_id, type, announcement_id)
  SELECT p_college_id, p_title, p_message, pr.id, auth.uid(), 'info', v_id
  FROM public.profiles pr
  WHERE pr.college_id = p_college_id
    AND (p_audience = 'all'
         OR (p_audience = 'staff' AND pr.role IN ('teacher', 'hod', 'warden', 'finance', 'admin'))
         OR (p_audience = 'students' AND pr.role = 'student'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_id, v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.send_announcement(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_announcement(UUID, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.send_placement_notification(
  p_college_id UUID,
  p_title TEXT,
  p_message TEXT,
  p_link TEXT,
  p_target_type TEXT,
  p_department_id UUID DEFAULT NULL,
  p_batch_year INTEGER DEFAULT NULL,
  p_drive_id UUID DEFAULT NULL,
  p_student_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (announcement_id UUID, recipient_count INTEGER)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
  v_n INTEGER;
  v_drive public.placement_drives;
  v_depts UUID[];
BEGIN
  -- The Server Action's gate (requireRole placement_cell/admin), here too
  -- (see send_announcement).
  IF p_college_id IS DISTINCT FROM public.get_my_college_id()
     OR public.get_my_role() NOT IN ('placement_cell', 'admin') THEN
    RAISE EXCEPTION 'placement notification: only the placement cell or an admin may send, and only to their own college' USING ERRCODE = '42501';
  END IF;
  IF p_target_type = 'eligible' THEN
    SELECT * INTO v_drive FROM public.placement_drives WHERE id = p_drive_id AND college_id = p_college_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'placement notification: drive not found in your college' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(pdd.department_id) INTO v_depts FROM public.placement_drive_departments pdd WHERE pdd.drive_id = p_drive_id;
  ELSIF p_target_type NOT IN ('college', 'department', 'batch_year', 'custom') THEN
    RAISE EXCEPTION 'placement notification: unknown target %', p_target_type USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.notifications (college_id, title, message, receiver_id, sender_id, type, link, announcement_id)
  SELECT p_college_id, p_title, p_message, st.user_id, auth.uid(), 'action_required', p_link, v_id
  FROM public.students st
  WHERE st.college_id = p_college_id
    AND (
      p_target_type = 'college'
      OR (p_target_type = 'department' AND st.department_id = p_department_id)
      OR (p_target_type = 'batch_year' AND st.batch_year = p_batch_year)
      OR (p_target_type = 'custom' AND st.user_id = ANY (COALESCE(p_student_user_ids, '{}')))
      OR (p_target_type = 'eligible'
          AND (v_drive.min_cgpa IS NULL OR COALESCE(st.cgpa, 0) >= v_drive.min_cgpa)
          AND (v_drive.eligible_batch_years IS NULL OR cardinality(v_drive.eligible_batch_years) = 0
               OR st.batch_year = ANY (v_drive.eligible_batch_years))
          AND (v_depts IS NULL OR cardinality(v_depts) = 0 OR st.department_id = ANY (v_depts)))
    );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_id, v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.send_placement_notification(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER, UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_placement_notification(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER, UUID, UUID[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 12. Push tokens of one send's recipients, a bounded page at a time
--
-- SECURITY DEFINER, deliberately. device_tokens_own (017) lets a user read
-- only their own tokens, so the old push step — run as the sender — got back
-- the sender's own token at most, and announcements never reached anyone's
-- phone. Reading other users' tokens is exactly what RLS forbids, so this
-- function does it under explicit rules instead:
--   - the caller must be the SENDER of that announcement, in their own
--     college, in a role that may send (the same list as
--     notifications_admin_send);
--   - only recipients of that announcement, only ACTIVE profiles, only
--     tokens registered in the same college;
--   - distinct tokens (a user with two phones gets two; one token once),
--     a keyset page of at most 1,000, and nothing but the token returned.
-- search_path is fixed and every object schema-qualified.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notification_push_tokens(p_announcement_id UUID, p_after TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (expo_push_token TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_college UUID := public.get_my_college_id();
BEGIN
  IF auth.uid() IS NULL
     OR v_college IS NULL
     OR public.get_my_role() NOT IN ('admin', 'teacher', 'hod', 'finance', 'director', 'warden', 'placement_cell')
     OR NOT EXISTS (
       SELECT 1 FROM public.notifications n
       WHERE n.announcement_id = p_announcement_id
         AND n.sender_id = auth.uid()
         AND n.college_id = v_college
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT d.expo_push_token
  FROM public.notifications n
  JOIN public.profiles pr ON pr.id = n.receiver_id AND pr.college_id = v_college AND pr.status = 'active'
  JOIN public.device_tokens d ON d.user_id = n.receiver_id AND d.college_id = v_college
  WHERE n.announcement_id = p_announcement_id
    AND n.college_id = v_college
    AND (p_after IS NULL OR d.expo_push_token > p_after)
  ORDER BY d.expo_push_token
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION public.notification_push_tokens(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notification_push_tokens(UUID, TEXT, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 13. "Sync now": queue a bounded batch of a window's payments
--
-- The old action selected the window's cleared payments (capped at 1,000,
-- and a failed read looked like "nothing to queue"), then enqueued them one
-- at a time — two or three requests each. This queues up to p_limit
-- payments per call, in one transaction, continuing after a keyset cursor
-- (created_at, id); the caller repeats until a batch comes back short.
--
-- SAME ROWS AS enqueue(). The idempotency key is lib/finance/idempotency.ts
-- idempotencyKey() exactly (a parity test pins the two), so a payment queued
-- here and one queued by enqueue() are the same row. The unique index on
-- (connection_id, idempotency_key) makes two concurrent Sync Nows, or this
-- and a TypeScript enqueue, resolve to one operation: ON CONFLICT DO NOTHING.
--
-- SECURITY INVOKER: fso_enqueue (049) still requires finance/admin of this
-- college, status PENDING and created_by = the caller; fso_operator_transition
-- allows PENDING -> QUEUED. Posting is unchanged: the worker claims each
-- operation with the compare-and-swap from 056.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_sync_idempotency_key(
  p_college_id UUID, p_connection_id UUID, p_entity_type TEXT, p_entity_id UUID, p_operation TEXT, p_version INTEGER DEFAULT 1
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT 'an_' || left(encode(sha256(convert_to(
    p_college_id::text || ':' || p_connection_id::text || ':' || p_entity_type || ':' || p_entity_id::text || ':' || p_operation || ':v' || p_version::text,
    'UTF8')), 'hex'), 40);
$$;
REVOKE ALL ON FUNCTION public.finance_sync_idempotency_key(UUID, UUID, TEXT, UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_sync_idempotency_key(UUID, UUID, TEXT, UUID, TEXT, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.queue_finance_sync_batch(
  p_connection_id UUID,
  p_from DATE,
  p_to DATE,
  p_after_created TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (scanned INTEGER, queued INTEGER, skipped INTEGER, last_created TIMESTAMPTZ, last_id UUID)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_conn public.finance_integration_connections;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
  v_batch UUID[];
  v_created TIMESTAMPTZ[];
  v_linked INTEGER;
  v_inserted UUID[];
  v_queued INTEGER;
BEGIN
  SELECT * INTO v_conn FROM public.finance_integration_connections
  WHERE id = p_connection_id AND college_id = public.get_my_college_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance sync: connection not found in your college' USING ERRCODE = '42501';
  END IF;
  IF v_conn.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'finance sync: this connection is % and cannot synchronise', v_conn.status USING ERRCODE = '22023';
  END IF;

  -- The batch: the window's cleared payments after the cursor, in a fixed order.
  SELECT array_agg(id ORDER BY created_at, id), array_agg(created_at ORDER BY created_at, id)
  INTO v_batch, v_created
  FROM (
    SELECT p.id, p.created_at
    FROM public.payments p
    WHERE p.college_id = v_conn.college_id
      AND p.status = 'cleared'
      AND p.created_at >= p_from::timestamp AT TIME ZONE 'UTC'
      AND p.created_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC'
      AND (p_after_created IS NULL OR (p.created_at, p.id) > (p_after_created, p_after_id))
    ORDER BY p.created_at, p.id
    LIMIT v_limit
  ) b;

  IF v_batch IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, p_after_created, p_after_id;
    RETURN;
  END IF;

  -- Already posted (linked): skipped, never re-queued.
  SELECT count(*) INTO v_linked
  FROM public.finance_external_links l
  WHERE l.connection_id = p_connection_id AND l.entity_type = 'payment' AND l.entity_id = ANY (v_batch);

  -- New operations, PENDING as fso_enqueue requires; an existing one is left alone.
  WITH ins AS (
    INSERT INTO public.finance_sync_operations
      (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, status, created_by, system_actor)
    SELECT v_conn.college_id, p_connection_id, v_conn.provider, 'payment', b.id, 'create_payment',
           public.finance_sync_idempotency_key(v_conn.college_id, p_connection_id, 'payment', b.id, 'create_payment', 1),
           'PENDING', auth.uid(), NULL
    FROM unnest(v_batch) AS b(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.finance_external_links l
      WHERE l.connection_id = p_connection_id AND l.entity_type = 'payment' AND l.entity_id = b.id
    )
    ON CONFLICT (connection_id, idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_inserted FROM ins;

  -- Queue every PENDING operation of this batch: the ones just created and
  -- any left PENDING earlier (what the TypeScript path did with enqueue()'s
  -- existing row). A concurrent Sync Now that already queued one finds it
  -- no longer PENDING and does not count it again.
  WITH q AS (
    UPDATE public.finance_sync_operations o
    SET status = 'QUEUED'
    WHERE o.connection_id = p_connection_id
      AND o.entity_type = 'payment'
      AND o.operation = 'create_payment'
      AND o.entity_id = ANY (v_batch)
      AND o.status = 'PENDING'
    RETURNING o.id
  )
  SELECT count(*) INTO v_queued FROM q;

  RETURN QUERY SELECT cardinality(v_batch), v_queued, v_linked,
                      v_created[cardinality(v_created)], v_batch[cardinality(v_batch)];
END;
$$;
REVOKE ALL ON FUNCTION public.queue_finance_sync_batch(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_finance_sync_batch(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 14. Platform crons (service role only)
--
-- snapshot-health-score and detect-risk-flags read whole tables across every
-- college with the service role — which PostgREST caps at 1,000 rows just the
-- same, across ALL colleges together. Per-college inputs computed here.
-- Granted to service_role only: these read every college by design.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.college_health_inputs()
RETURNS TABLE (
  college_id UUID,
  open_risk_flags BIGINT,
  pending_decisions BIGINT,
  faculty_count BIGINT,
  active_students BIGINT,
  hostel_capacity BIGINT,
  hostel_occupancy BIGINT,
  dept_with_attendance BIGINT,
  dept_with_backlog BIGINT,
  dept_with_cgpa BIGINT,
  avg_attendance NUMERIC,
  avg_backlog_inverse NUMERIC,
  avg_cgpa_pct NUMERIC,
  dept_with_placement BIGINT,
  avg_placement NUMERIC,
  fee_collection_pct NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT c.id,
    (SELECT count(*) FROM public.risk_flags f WHERE f.college_id = c.id AND f.status IN ('open', 'assigned', 'acknowledged', 'in_progress')),
    (SELECT count(*) FROM public.decisions d WHERE d.college_id = c.id AND d.status = 'pending'),
    (SELECT count(*) FROM public.profiles p WHERE p.college_id = c.id AND p.role IN ('teacher', 'hod')),
    (SELECT count(*) FROM public.students s WHERE s.college_id = c.id AND s.status = 'active'),
    (SELECT COALESCE(sum(r.capacity), 0) FROM public.hostel_rooms r JOIN public.hostel_blocks b ON b.id = r.block_id WHERE b.college_id = c.id),
    (SELECT COALESCE(sum(r.occupancy), 0) FROM public.hostel_rooms r JOIN public.hostel_blocks b ON b.id = r.block_id WHERE b.college_id = c.id),
    h.n_att, h.n_back, h.n_cgpa, h.avg_att, h.avg_back_inv, h.avg_cgpa_pct, h.n_place, h.avg_place,
    (SELECT fs.collection_pct FROM public.mv_fee_summary_raw fs WHERE fs.college_id = c.id LIMIT 1)
  FROM public.colleges c
  LEFT JOIN LATERAL (
    SELECT count(dh.attendance_pct) AS n_att,
           count(dh.backlog_rate) AS n_back,
           count(dh.avg_cgpa) AS n_cgpa,
           avg(dh.attendance_pct) AS avg_att,
           avg(GREATEST(0, 100 - dh.backlog_rate)) AS avg_back_inv,
           avg(dh.avg_cgpa / 10 * 100) AS avg_cgpa_pct,
           count(dh.placement_rate) AS n_place,
           avg(dh.placement_rate) AS avg_place
    FROM public.mv_department_health_raw dh
    WHERE dh.college_id = c.id
  ) h ON true;
$$;
REVOKE ALL ON FUNCTION public.college_health_inputs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.college_health_inputs() TO service_role;

CREATE OR REPLACE FUNCTION public.hostel_block_capacity_all()
RETURNS TABLE (college_id UUID, block_id UUID, block_name TEXT, capacity BIGINT, occupancy BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT b.college_id, b.id, b.name, COALESCE(sum(r.capacity), 0)::bigint, COALESCE(sum(r.occupancy), 0)::bigint
  FROM public.hostel_blocks b
  LEFT JOIN public.hostel_rooms r ON r.block_id = b.id
  GROUP BY b.college_id, b.id, b.name;
$$;
REVOKE ALL ON FUNCTION public.hostel_block_capacity_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hostel_block_capacity_all() TO service_role;
