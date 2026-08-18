/**
 * OF-013 — a system-submitted approval request could not be created at all.
 *
 * FOUND BY: the R1 §7 extreme end-to-end run, which is the first thing that ever reached the
 * approval branch of `processSourceEvent` against a real database. The finance consumer was only
 * wired in R1 §4, and the classifier that gets a message that far is an owner gate, so nothing had
 * exercised it before.
 *
 * THE DEFECT: `loadCompanyContext` returns the literal string `"system"` as `submitterUserId`, and
 * `approval_requests.submitted_by` is `uuid NOT NULL`. Every captured finance message that reached
 * the approval branch failed with `invalid input syntax for type uuid: "system"`, was retried, and
 * dead-lettered after the attempt budget. A message describing a real payment therefore reached no
 * approver, and the failure looked like a transient processing error rather than a design gap.
 *
 * THE FIX (migration 0081) gives the request an explicit PROVENANCE, exactly as migration 0078 did
 * for routing decisions: a request is either submitted by a person (`submitted_by` non-null) or by
 * the system (`submitted_by` null, `submitted_by_source = 'system'`), never a person-shaped string
 * standing in for the system. The pairing is a check constraint, the system source is refused to
 * any non-service caller by a trigger, and provenance is immutable after insert.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let co: string, fe: string, person: string;

describe.skipIf(!enabled)("OF-013 — approval provenance (disposable local PostgreSQL)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('of013','LKR') returning id`)).rows[0].id;
    fe = (await db.query(
      `insert into financial_events (company_id, event_type, state, currency, current_version, correlation_id)
       values ($1,'expense_payment','awaiting_approval','LKR',1,$2) returning id`, [co, `of013_${rnd()}`])).rows[0].id;
    person = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [person]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'of013 person',true) on conflict do nothing`, [person]);
  });

  afterAll(async () => {
    for (const sql of [
      `delete from approval_requests where company_id=$1`,
      `delete from financial_events where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    try { await db.query(`delete from users where id=$1`, [person]); } catch { /* noop */ }
    await db?.end().catch(() => {});
  });

  it("THE DEFECT: a person-shaped string can never stand in for the system", async () => {
    // This is what the pipeline sent, and why it dead-lettered every material captured payment.
    await expect(
      db.query(`insert into approval_requests (company_id, financial_event_id, approvals_required, submitted_by)
                values ($1,$2,1,'system')`, [co, fe]),
    ).rejects.toMatchObject({ code: "22P02" });
  });

  it("THE FIX: the system may submit a request with NO human submitter", async () => {
    const r = await db.query(
      `insert into approval_requests (company_id, financial_event_id, approvals_required, submitted_by, submitted_by_source)
       values ($1,$2,1,null,'system') returning id, submitted_by, submitted_by_source`, [co, fe]);
    expect(r.rows[0].submitted_by).toBeNull();
    expect(r.rows[0].submitted_by_source).toBe("system");
    await db.query(`delete from approval_requests where id=$1`, [r.rows[0].id]);
  });

  it("a HUMAN request must still name the person, and a SYSTEM one must not", async () => {
    await db.query("begin");
    try {
      await db.query(`savepoint a`);
      await expect(db.query(
        `insert into approval_requests (company_id, financial_event_id, approvals_required, submitted_by, submitted_by_source)
         values ($1,$2,1,null,'human')`, [co, fe])).rejects.toMatchObject({ constraint: "approval_requests_submitter_provenance_check" });
      await db.query(`rollback to savepoint a`);

      await expect(db.query(
        `insert into approval_requests (company_id, financial_event_id, approvals_required, submitted_by, submitted_by_source)
         values ($1,$2,1,$3,'system')`, [co, fe, person])).rejects.toMatchObject({ constraint: "approval_requests_submitter_provenance_check" });
    } finally { await db.query("rollback"); }
  });

  it("an AUTHENTICATED caller cannot submit AS the system, so self-approval cannot be evaded", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: person })]);
      await expect(db.query(
        `insert into approval_requests (company_id, financial_event_id, approvals_required, submitted_by, submitted_by_source)
         values ($1,$2,1,null,'system')`, [co, fe])).rejects.toThrow(/only the service context/);
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });

  it("provenance is IMMUTABLE — a system request cannot later be attributed to a person", async () => {
    const id = (await db.query(
      `insert into approval_requests (company_id, financial_event_id, approvals_required, submitted_by, submitted_by_source)
       values ($1,$2,1,null,'system') returning id`, [co, fe])).rows[0].id;
    await expect(db.query(`update approval_requests set submitted_by=$2 where id=$1`, [id, person]))
      .rejects.toThrow(/submitted_by is immutable/);
    await expect(db.query(`update approval_requests set submitted_by_source='human' where id=$1`, [id]))
      .rejects.toThrow(/submitted_by_source is immutable/);
    // The mutable part — the decision — still works.
    await db.query(`update approval_requests set status='approved' where id=$1`, [id]);
    expect((await db.query(`select status from approval_requests where id=$1`, [id])).rows[0].status).toBe("approved");
    await db.query(`delete from approval_requests where id=$1`, [id]);
  });
});
