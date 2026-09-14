import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, SEC, COLLEGE_A, GATE_MAIN, GATE_NORTH } from "./staging/harness";

/**
 * §27 and §45 Test 7 — two guards, one QR, the same instant.
 *
 * This is the test the whole locking design in record_gate_movement()
 * exists for, and it is the one PGlite structurally cannot run: a single
 * connection cannot interleave with itself. Each case below starts two real
 * psql processes at the same moment against real PostgreSQL and then asks
 * the only question that matters — what does the database hold afterwards.
 *
 * A note on what "passing" means here. The scan function RETURNS an outcome
 * rather than raising, so both sessions exit 0; the loser is the one whose
 * outcome is ALREADY_OUTSIDE. Counting exit codes would therefore prove
 * nothing at all. Every assertion below reads the persisted state instead:
 * one ledger row, one status, one timestamp.
 *
 * BLOCKED, not skipped-as-pass, when no PostgreSQL binary is present.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("real-PostgreSQL gate security concurrency", () => {
    it.skip("BLOCKED: no PostgreSQL binary (initdb/pg_ctl/psql) on this machine", () => {});
  });
}

maybe("real-PostgreSQL gate security concurrency", () => {
  let cluster: Cluster;
  beforeAll(() => { cluster = startCluster(); });
  afterAll(() => cluster?.stop());

  /** An approved pass whose credential window contains now(). */
  function approvedPass(db: string): { passId: string; credentialId: string } {
    owner(cluster, db,
      `INSERT INTO gate_passes (college_id, student_id, destination, reason, exit_time, return_time, status, approved_by, approved_at)
         VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now() - interval '1 hour', now() + interval '6 hours', 'pending', NULL, NULL)`);
    const passId = owner(cluster, db,
      `SELECT id FROM gate_passes WHERE student_id='${S.a}' AND destination='Market' ORDER BY created_at DESC LIMIT 1`);
    // The credential is issued by the approval transition, so go through it.
    owner(cluster, db,
      `UPDATE gate_passes SET status='approved', approved_by='${U.warden}', approved_at=now() WHERE id='${passId}'`);
    const credentialId = owner(cluster, db,
      `SELECT id FROM gate_pass_credentials WHERE gate_pass_id='${passId}' AND status='ACTIVE'`);
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
    return { passId, credentialId };
  }

  const scan = (db: string, guard: string, credentialId: string, gateId: string, delayMs = 0) =>
    session(cluster, db,
      `${delayMs ? `SELECT pg_sleep(${delayMs / 1000});` : ""}
       SELECT outcome FROM public.record_gate_movement('${credentialId}','${gateId}','{}'::jsonb);`,
      guard);

  it("two guards scanning the same QR at once record exactly one exit", async () => {
    const db = cluster.fork();
    try {
      const { passId, credentialId } = approvedPass(db);

      const [a, b] = await concurrently(
        scan(db, U.guardMain, credentialId, GATE_MAIN),
        scan(db, U.guardNorth, credentialId, GATE_NORTH)
      );

      // Both calls succeed as calls; only one of them is a movement.
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const outcomes = [a.stdout, b.stdout].map((s) => s.trim().split("\n").pop() ?? "");
      expect(outcomes.filter((o) => o === "RECORDED")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "ALREADY_OUTSIDE")).toHaveLength(1);

      expect(owner(cluster, db, `SELECT count(*) FROM gate_movements WHERE gate_pass_id='${passId}'`)).toBe("1");
      expect(owner(cluster, db, `SELECT status FROM gate_passes WHERE id='${passId}'`)).toBe("active");
      // One exit stamp, and it is the movement's.
      const exits = owner(cluster, db,
        `SELECT count(*) FROM gate_passes gp JOIN gate_movements m ON m.gate_pass_id = gp.id
          WHERE gp.id='${passId}' AND m.movement_type='OUT' AND gp.actual_exit IS NOT NULL`);
      expect(exits).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("the same guard double-tapping produces one exit, not an exit and an immediate return", async () => {
    const db = cluster.fork();
    try {
      const { passId, credentialId } = approvedPass(db);
      const [a, b] = await concurrently(
        scan(db, U.guardMain, credentialId, GATE_MAIN),
        scan(db, U.guardMain, credentialId, GATE_MAIN)
      );
      expect([a.code, b.code]).toEqual([0, 0]);
      expect(owner(cluster, db, `SELECT count(*) FROM gate_movements WHERE gate_pass_id='${passId}'`)).toBe("1");
      expect(owner(cluster, db, `SELECT count(*) FROM gate_movements WHERE gate_pass_id='${passId}' AND movement_type='IN'`)).toBe("0");
      expect(owner(cluster, db, `SELECT status FROM gate_passes WHERE id='${passId}'`)).toBe("active");
    } finally { cluster.drop(db); }
  });

  it("an exit and a return racing on one pass cannot both land", async () => {
    const db = cluster.fork();
    try {
      const { passId, credentialId } = approvedPass(db);
      // The second session arrives a beat later and finds the pass already
      // 'active' — but inside the duplicate window, so it is refused as a
      // duplicate rather than becoming a return.
      const [a, b] = await concurrently(
        scan(db, U.guardMain, credentialId, GATE_MAIN),
        scan(db, U.guardNorth, credentialId, GATE_NORTH, 120)
      );
      expect([a.code, b.code]).toEqual([0, 0]);
      expect(owner(cluster, db, `SELECT count(*) FROM gate_movements WHERE gate_pass_id='${passId}'`)).toBe("1");
      expect(owner(cluster, db, `SELECT actual_return FROM gate_passes WHERE id='${passId}'`)).toBe("");
    } finally { cluster.drop(db); }
  });

  it("the unique index holds even with the state machine bypassed entirely", async () => {
    // Belt and braces: two owner sessions writing the ledger directly, with
    // no function and no RLS in the way. idx_gm_one_per_direction is the
    // floor under every check above it.
    const db = cluster.fork();
    try {
      const { passId } = approvedPass(db);
      const insert = () => session(cluster, db,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role)
           VALUES ('${COLLEGE_A}','${passId}','${S.a}','${GATE_MAIN}','OUT','${U.admin}','admin');`);
      const [a, b] = await concurrently(insert(), insert());
      const ok = [a, b].filter((r) => r.code === 0);
      expect(ok, `${a.stderr}|${b.stderr}`).toHaveLength(1);
      expect([a, b].find((r) => r.code !== 0)!.stderr).toMatch(/idx_gm_one_per_direction|duplicate key/i);
      expect(owner(cluster, db, `SELECT count(*) FROM gate_movements WHERE gate_pass_id='${passId}'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("a warden override and a guard scan racing on one pass produce one movement", async () => {
    const db = cluster.fork();
    try {
      const { passId, credentialId } = approvedPass(db);
      const [a, b] = await concurrently(
        scan(db, U.guardMain, credentialId, GATE_MAIN),
        session(cluster, db,
          `SELECT outcome FROM public.record_manual_gate_movement('${passId}','OUT','${GATE_NORTH}','student presented at the north gate without a phone');`,
          U.warden)
      );
      // Whichever arrives second finds the pass no longer 'approved'.
      expect([a.code, b.code].filter((c) => c === 0).length).toBeGreaterThanOrEqual(1);
      expect(owner(cluster, db, `SELECT count(*) FROM gate_movements WHERE gate_pass_id='${passId}'`)).toBe("1");
      expect(owner(cluster, db, `SELECT status FROM gate_passes WHERE id='${passId}'`)).toBe("active");
    } finally { cluster.drop(db); }
  });

  it("two directors assigning the same guard to the same gate create one live assignment", async () => {
    const db = cluster.fork();
    try {
      const assign = () => session(cluster, db,
        `INSERT INTO public.security_gate_assignments (college_id, security_personnel_id, gate_id, assigned_by)
           VALUES ('${COLLEGE_A}','${SEC.north}','${GATE_MAIN}',auth.uid());`, U.director);
      const [a, b] = await concurrently(assign(), assign());
      expect([a, b].filter((r) => r.code === 0), `${a.stderr}|${b.stderr}`).toHaveLength(1);
      expect(owner(cluster, db,
        `SELECT count(*) FROM security_gate_assignments WHERE security_personnel_id='${SEC.north}' AND gate_id='${GATE_MAIN}' AND revoked_at IS NULL`)).toBe("1");
    } finally { cluster.drop(db); }
  });
});
