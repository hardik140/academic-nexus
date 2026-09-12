import type { PGlite } from "@electric-sql/pglite";

/**
 * Deterministic integrity scan (§36) — every invariant the model relies on
 * that is NOT already a constraint, plus a catalog-driven tenant scan that
 * covers the ~70 single-column foreign keys between college-scoped tables
 * that still carry no college_id (047 §7l bound the academic ones; the
 * hostel, finance, placement and workflow keys are a recorded follow-up).
 *
 * Runs as the owner, so nothing is hidden by RLS. Returns every check with
 * its violation count; a caller asserts the list of non-zero checks is
 * exactly what it expects (normally: empty).
 */

export interface IntegrityFinding {
  check: string;
  count: number;
}

const CHECKS: Array<[string, string]> = [
  // ---- academic --------------------------------------------------------
  ["attendance for a student not enrolled in that offering",
    `SELECT count(*) FROM attendance a WHERE NOT EXISTS (SELECT 1 FROM course_enrollments e WHERE e.offering_id=a.offering_id AND e.student_id=a.student_id)`],
  ["marks for a student not enrolled in that offering",
    `SELECT count(*) FROM marks m WHERE NOT EXISTS (SELECT 1 FROM course_enrollments e WHERE e.offering_id=m.offering_id AND e.student_id=m.student_id)`],
  ["offering instructor who is not teaching staff (teacher/hod)",
    `SELECT count(*) FROM course_offerings o JOIN profiles p ON p.id=o.instructor_id WHERE p.role NOT IN ('teacher','hod')`],
  ["offering instructor whose account is not active",
    `SELECT count(*) FROM course_offerings o JOIN profiles p ON p.id=o.instructor_id WHERE p.status <> 'active' AND o.status IN ('planned','active')`],
  ["more than one active semester in a college",
    `SELECT count(*) FROM (SELECT college_id FROM semesters WHERE status='active' GROUP BY college_id HAVING count(*)>1) x`],
  ["active semester whose academic year is not active",
    `SELECT count(*) FROM semesters s JOIN academic_years ay ON ay.id=s.academic_year_id WHERE s.status='active' AND ay.status<>'active'`],
  ["semester whose legacy is_current disagrees with status",
    `SELECT count(*) FROM semesters WHERE is_current IS DISTINCT FROM (status='active')`],
  ["substitution 'assigned' with no substitute, or 'needed' with one",
    `SELECT count(*) FROM substitution_assignments WHERE (status='assigned' AND substitute_teacher_id IS NULL) OR (status='needed' AND substitute_teacher_id IS NOT NULL)`],
  ["substitution where the substitute is the absent teacher",
    `SELECT count(*) FROM substitution_assignments WHERE substitute_teacher_id = original_teacher_id`],
  ["attendance correction approved by its own submitter",
    `SELECT count(*) FROM attendance_correction_requests WHERE status='approved' AND reviewed_by = submitted_by`],
  ["leave approved by the requester",
    `SELECT count(*) FROM leave_requests WHERE status IN ('approved','rejected') AND approved_by = requested_by`],
  ["decided request without a reviewer stamp",
    `SELECT (SELECT count(*) FROM leave_requests WHERE status IN ('approved','rejected') AND approved_by IS NULL)
          + (SELECT count(*) FROM refund_requests WHERE status IN ('approved','rejected') AND reviewed_by IS NULL)
          + (SELECT count(*) FROM attendance_correction_requests WHERE status IN ('approved','rejected') AND reviewed_by IS NULL)
          + (SELECT count(*) FROM room_transfer_requests WHERE status IN ('approved','rejected') AND reviewed_by IS NULL)`],
  ["pending request carrying a reviewer stamp",
    `SELECT (SELECT count(*) FROM leave_requests WHERE status='pending' AND approved_by IS NOT NULL)
          + (SELECT count(*) FROM refund_requests WHERE status='pending' AND reviewed_by IS NOT NULL)
          + (SELECT count(*) FROM attendance_correction_requests WHERE status='pending' AND reviewed_by IS NOT NULL)
          + (SELECT count(*) FROM room_transfer_requests WHERE status='pending' AND reviewed_by IS NOT NULL)`],

  // ---- authority master data ------------------------------------------
  ["department head whose profile role is not 'hod'",
    `SELECT count(*) FROM departments d JOIN profiles p ON p.id=d.hod_id WHERE p.role <> 'hod'`],
  ["department head in another college",
    `SELECT count(*) FROM departments d JOIN profiles p ON p.id=d.hod_id WHERE p.college_id <> d.college_id`],
  ["block warden whose profile role is not 'warden'",
    `SELECT count(*) FROM hostel_blocks b JOIN profiles p ON p.id=b.warden_id WHERE p.role <> 'warden'`],
  ["profile with role 'hod' heading no department",
    `SELECT count(*) FROM profiles p WHERE p.role='hod' AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.hod_id=p.id)`],
  ["profile with role 'warden' wardening no block",
    `SELECT count(*) FROM profiles p WHERE p.role='warden' AND NOT EXISTS (SELECT 1 FROM hostel_blocks b WHERE b.warden_id=p.id)`],

  // ---- finance ---------------------------------------------------------
  ["fee paid_amount negative or above the fee amount",
    `SELECT count(*) FROM fees WHERE paid_amount < 0 OR paid_amount > amount`],
  ["fee paid_amount disagrees with its payments minus approved refunds",
    `SELECT count(*) FROM fees f
      WHERE f.paid_amount <> COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.fee_id=f.id AND p.status IN ('cleared','refunded')),0)
                          - COALESCE((SELECT sum(r.amount) FROM refund_requests r JOIN payments p ON p.id=r.payment_id WHERE p.fee_id=f.id AND r.status='approved'),0)`],
  ["fee status 'paid' with a balance outstanding, or 'partial' with nothing paid",
    `SELECT count(*) FROM fees WHERE (status='paid' AND paid_amount < amount) OR (status='partial' AND (paid_amount <= 0 OR paid_amount >= amount))`],
  ["payment amount not positive",
    `SELECT count(*) FROM payments WHERE amount <= 0`],
  ["approved refunds exceeding their payment",
    `SELECT count(*) FROM payments p WHERE (SELECT COALESCE(sum(amount),0) FROM refund_requests r WHERE r.payment_id=p.id AND r.status='approved') > p.amount`],
  ["payment marked refunded while its approved refunds fall short of it",
    `SELECT count(*) FROM payments p WHERE p.status='refunded' AND (SELECT COALESCE(sum(amount),0) FROM refund_requests r WHERE r.payment_id=p.id AND r.status='approved') < p.amount`],
  ["refund request whose student is not the payment's student",
    `SELECT count(*) FROM refund_requests r JOIN payments p ON p.id=r.payment_id WHERE p.student_id <> r.student_id`],
  ["payment whose student is not the fee's student",
    `SELECT count(*) FROM payments p JOIN fees f ON f.id=p.fee_id WHERE f.student_id <> p.student_id`],

  // ---- hostel ----------------------------------------------------------
  ["student with more than one active allocation",
    `SELECT count(*) FROM (SELECT student_id FROM hostel_allocations WHERE status='active' GROUP BY student_id HAVING count(*)>1) x`],
  ["room occupancy disagrees with its active allocations",
    `SELECT count(*) FROM hostel_rooms r WHERE r.occupancy <> (SELECT count(*) FROM hostel_allocations a WHERE a.room_id=r.id AND a.status='active')`],
  ["room over capacity",
    `SELECT count(*) FROM hostel_rooms r WHERE (SELECT count(*) FROM hostel_allocations a WHERE a.room_id=r.id AND a.status='active') > r.capacity`],
  ["active allocation in a room of another college",
    `SELECT count(*) FROM hostel_allocations a JOIN hostel_rooms r ON r.id=a.room_id JOIN hostel_blocks b ON b.id=r.block_id WHERE b.college_id <> a.college_id`],
  ["gate pass stamps inconsistent with status",
    `SELECT count(*) FROM gate_passes WHERE
        (status='pending'  AND (approved_by IS NOT NULL OR approved_at IS NOT NULL OR actual_exit IS NOT NULL OR actual_return IS NOT NULL))
     OR (status IN ('approved','rejected') AND (approved_by IS NULL OR approved_at IS NULL OR actual_exit IS NOT NULL OR actual_return IS NOT NULL))
     OR (status='active'   AND (approved_by IS NULL OR actual_exit IS NULL OR actual_return IS NOT NULL))
     OR (status='returned' AND (approved_by IS NULL OR actual_exit IS NULL OR actual_return IS NULL))`],
  ["student outside on more than one pass at once",
    `SELECT count(*) FROM (SELECT student_id FROM gate_passes WHERE status='active' GROUP BY student_id HAVING count(*)>1) x`],
  ["gate pass approved by someone who is not warden or admin",
    `SELECT count(*) FROM gate_passes g JOIN profiles p ON p.id=g.approved_by WHERE p.role NOT IN ('warden','admin')`],

  // ---- audit -----------------------------------------------------------
  ["audit row whose actor is in another college",
    `SELECT count(*) FROM audit_logs l JOIN profiles p ON p.id=l.user_id WHERE p.college_id <> l.college_id`],
];

/**
 * Signals that are inconsistencies in the MODEL rather than violations of a
 * rule the system enforces. Reported separately: a legitimate operation can
 * produce them today, and whether it should is a register item.
 *
 *   active offering in a closed semester — closing a term (§7k) does not
 *   complete or freeze the offerings in it; nothing keys on semester status
 *   downstream (lib/offerings.ts records finalisation as not implemented).
 */
export const ADVISORY: Array<[string, string]> = [
  ["active offering in a closed semester",
    `SELECT count(*) FROM course_offerings o JOIN semesters s ON s.id=o.semester_id WHERE o.status='active' AND s.status='closed'`],
];

export async function scanAdvisory(db: PGlite): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  for (const [check, sql] of ADVISORY) {
    const r = await db.query<Record<string, unknown>>(sql);
    out.push({ check, count: Number(Object.values(r.rows[0])[0]) });
  }
  return out;
}

/** Every single-column FK between college-scoped tables, checked for a cross-college reference. */
async function tenantChecks(db: PGlite): Promise<Array<[string, string]>> {
  const res = await db.query<{ child: string; col: string; parent: string }>(`
    WITH scoped AS (
      SELECT c.oid, c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='college_id' AND NOT a.attisdropped
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
    )
    SELECT ch.relname child, a.attname col, pa.relname parent
    FROM pg_constraint con
    JOIN scoped ch ON ch.oid=con.conrelid
    JOIN scoped pa ON pa.oid=con.confrelid
    JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[1]
    WHERE con.contype='f' AND array_length(con.conkey,1)=1 AND pa.relname <> 'colleges'
    ORDER BY 1,2`);
  return res.rows.map((r) => [
    `cross-college reference: ${r.child}.${r.col} -> ${r.parent}`,
    // profiles.college_id may be NULL (super_admin); NULL never counts as a mismatch.
    `SELECT count(*) FROM ${r.child} c JOIN ${r.parent} p ON p.id = c.${r.col} WHERE p.college_id IS NOT NULL AND p.college_id <> c.college_id`,
  ]);
}

export async function scanIntegrity(db: PGlite): Promise<IntegrityFinding[]> {
  const all = [...CHECKS, ...(await tenantChecks(db))];
  const out: IntegrityFinding[] = [];
  for (const [check, sql] of all) {
    const r = await db.query<Record<string, unknown>>(sql);
    out.push({ check, count: Number(Object.values(r.rows[0])[0]) });
  }
  return out;
}

/** The subset that is non-zero — what a test asserts against. */
export async function integrityViolations(db: PGlite): Promise<string[]> {
  return (await scanIntegrity(db)).filter((f) => f.count > 0).map((f) => `${f.check} (${f.count})`);
}
