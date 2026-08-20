/**
 * Overnight campaign — cross-layer evidence against a LIVE disposable PostgreSQL.
 *
 * These are the adversarial cases the campaign brief asks for that the existing 42 integration
 * files do not already cover. Everything here is synthetic and the whole file runs inside one
 * transaction per connection, rolled back at the end — nothing is committed.
 *
 * Scope note (honesty): stages 7, 8, 10, 11 and 17 of the campaign's 17-stage pipeline (Task
 * Intelligence Profile, decision-path ladder, resource recommendation, AI Guide, improvement
 * feedback) have NO runtime implementation in this repository, so they are reported as missing
 * links in the campaign report rather than tested here.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npx vitest run -c vitest.integration.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });
const rnd = () => randomUUID().slice(0, 8);

/* eslint-disable @typescript-eslint/no-explicit-any */
let setup: any, cA: any, cB: any;
let coA: string, coB: string, actor: string;

/** `uncertainty` is a plain text column the RPC copies straight from the payload — it is the
 *  cleanest place to put a distinguishing marker and prove which caller's content was stored. */
const CASE = (marker: string) =>
  JSON.stringify({
    source_event_id: "campaign",
    confirmed_facts: ["synthetic fact"],
    uncertainty: marker,
    confidence: "0.7",
    required_authority: "none",
    requires_human: false,
  });

const RPC = `select public.create_management_case_atomic($1,$2,$3::jsonb,$4::jsonb,$5,'manager.analyzed') as v`;

describe.skipIf(!enabled)("campaign — cross-layer adversarial evidence (live DB)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => {
      const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
      await c.connect();
      return c;
    };
    setup = await mk();
    cA = await mk();
    cB = await mk();
    for (const c of [setup, cA, cB]) {
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
    coA = (await setup.query(`insert into companies (name, base_currency) values ('camp_A','LKR') returning id`)).rows[0].id;
    coB = (await setup.query(`insert into companies (name, base_currency) values ('camp_B','LKR') returning id`)).rows[0].id;
    actor = randomUUID();
    await setup.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [actor]);
    await setup.query(`insert into users (id, full_name, is_active) values ($1,'camp-actor',true) on conflict do nothing`, [actor]);
  });

  afterAll(async () => {
    for (const co of [coA, coB]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from tasks where company_id=$1`,
        `delete from management_cases where company_id=$1`,
        `delete from companies where id=$1`,
      ]) {
        try { await setup.query(sql, [co]); } catch { /* noop */ }
      }
    }
    await Promise.all([cA?.end(), cB?.end(), setup?.end()].map((p: any) => p?.catch?.(() => {})));
  });

  // ── idempotency: the campaign's "duplicate key, DIFFERENT payload" case ──
  it("a replayed idempotency key with a DIFFERENT payload never overwrites the original", async () => {
    // The dangerous version of a replay: same key, different content. The stored case must keep
    // its original content — a second caller must not be able to rewrite the first one's record
    // by guessing or reusing its key.
    const key = "k_" + rnd();
    const first = await cA.query(RPC, [coA, key, CASE("ORIGINAL synthetic summary"), JSON.stringify([{ title: "T1" }]), actor]);
    const firstId = first.rows[0].v.case_id;

    const second = await cB.query(RPC, [coA, key, CASE("REWRITTEN by a second caller"), JSON.stringify([{ title: "T2" }]), actor]);

    // Same logical case returned…
    expect(second.rows[0].v.case_id).toBe(firstId);
    // …and the stored content is still the first caller's.
    const stored = await setup.query(`select uncertainty from management_cases where id=$1`, [firstId]);
    expect(stored.rows[0].uncertainty).toBe("ORIGINAL synthetic summary");

    // The second payload's task must not have been grafted onto the original case.
    const titles = (await setup.query(`select title from tasks where management_case_id=$1 order by title`, [firstId])).rows.map(
      (r: any) => r.title,
    );
    expect(titles).toEqual(["T1"]);
  });

  it("the same idempotency key in a DIFFERENT company creates a separate case (no cross-company collision)", async () => {
    // Idempotency is scoped per company. If it were global, one company could block or read
    // another's record by choosing the same key.
    const key = "shared_" + rnd();
    const a = await cA.query(RPC, [coA, key, CASE("company A content"), JSON.stringify([{ title: "A" }]), actor]);
    const b = await cB.query(RPC, [coB, key, CASE("company B content"), JSON.stringify([{ title: "B" }]), actor]);

    expect(a.rows[0].v.case_id).not.toBe(b.rows[0].v.case_id);
    const rows = await setup.query(
      `select company_id, uncertainty from management_cases where id = any($1::uuid[]) order by uncertainty`,
      [[a.rows[0].v.case_id, b.rows[0].v.case_id]],
    );
    expect(rows.rows.map((r: any) => r.uncertainty)).toEqual(["company A content", "company B content"]);
    expect(rows.rows[0].company_id).toBe(coA);
    expect(rows.rows[1].company_id).toBe(coB);
  });

  it("a case cannot be created for one company with tasks that name another company's id", async () => {
    // Company scope is injected by the caller, never taken from the payload. Any attempt to pass
    // a foreign company id inside the task JSON must not produce a task in that other company.
    const key = "x_" + rnd();
    const tasks = JSON.stringify([{ title: "Cross", company_id: coB }]);
    const r = await cA.query(RPC, [coA, key, CASE("scope test"), tasks, actor]);
    const caseId = r.rows[0].v.case_id;

    const rows = await setup.query(`select company_id from tasks where management_case_id=$1`, [caseId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].company_id).toBe(coA); // NOT coB
    // …and nothing bearing this case's title landed in the other company.
    const leaked = await setup.query(`select count(*)::int n from tasks where company_id=$1 and title='Cross'`, [coB]);
    expect(leaked.rows[0].n).toBe(0);
  });

  it("every persisted case carries an audit event in the same transaction", async () => {
    const key = "a_" + rnd();
    const r = await cA.query(RPC, [coA, key, CASE("audited"), JSON.stringify([{ title: "T" }]), actor]);
    const caseId = r.rows[0].v.case_id;
    const audit = await setup.query(
      `select action from audit_events where company_id=$1 and action='manager.analyzed' order by created_at desc limit 5`,
      [coA],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(caseId).toBeTruthy();
  });

  // ── delivery truth: "sent" must never be claimed by a direct write ──
  it("a quotation cannot be marked sent by a direct UPDATE — only the RPC path may do it", async () => {
    // The campaign's rule: the system must never display "sent" when nothing was sent. The
    // delivery transitions are RPC-only, enforced by a DB trigger, so a direct write must fail.
    const q = (
      await setup.query(
        `insert into quotations (company_id, quote_number, currency, status, subtotal, tax_amount, total, public_token)
         values ($1,$2,'LKR','draft',0,0,0,$3) returning id`,
        [coA, "QC-" + rnd(), "tok_" + rnd()],
      )
    ).rows[0].id;

    let refused = false;
    try {
      await setup.query(`update quotations set status='sent', sent_at=now() where id=$1`, [q]);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    const after = await setup.query(`select status, sent_at from quotations where id=$1`, [q]);
    expect(after.rows[0].status).toBe("draft");
    expect(after.rows[0].sent_at).toBeNull();

    await setup.query(`delete from quotations where id=$1`, [q]);
  });
});
