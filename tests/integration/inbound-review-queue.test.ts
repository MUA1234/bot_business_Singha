/**
 * FOUND-003 — the manual-review queue (migration 0075). Live PostgreSQL.
 *
 * `recordForReview` used to write a log line. The message was durable, but nobody was going to see
 * it: "fails closed to manual review" pointed at nowhere. These scenarios prove the queue is a real
 * company-scoped row, that recording it is idempotent under webhook redelivery, that closing one
 * requires the capability AT THE DATABASE (not merely in the app), that the audit event is written
 * in the same transaction, and that a second decision cannot overwrite the first.
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
let coA: string, coB: string;
let reviewer: string, bystander: string, otherCoReviewer: string;

const record = (company: string, msgId: string, reason = "no_finance_classifier", over: Record<string, unknown> = {}) =>
  db.query(
    `select * from public.record_inbound_review($1,'whatsapp',$2,$3,$4,null,$5,$6,$7,$8)`,
    [
      company, msgId, reason,
      over.detail ?? "a staff member wrote in", over.sender ?? "94711234567",
      over.actorType ?? "staff", over.match ?? "exact", over.body ?? "paid LKR 45,000 to Acme",
    ],
  ).then((r: any) => r.rows[0]);

/** A user with an active membership, optionally holding the review capability. */
async function makeUser(company: string, withCapability: boolean): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, `u_${rnd()}`]);
  const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, id])).rows[0].id;
  await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`,
    [m, company, withCapability ? "owner_management" : "staff_submitter"]);
  return id;
}

describe.skipIf(!enabled)("0075 — the inbound review queue (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    coA = (await db.query(`insert into companies (name, base_currency) values ('reviewA','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('reviewB','LKR') returning id`)).rows[0].id;
    reviewer = await makeUser(coA, true);
    bystander = await makeUser(coA, false);
    otherCoReviewer = await makeUser(coB, true);
  });
  afterAll(async () => {
    for (const c of [coA, coB]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from inbound_reviews where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    await db?.end().catch(() => {});
  });

  it("a message that needs a person becomes a ROW carrying why, who and what they said", async () => {
    const msg = `wamid.${rnd()}`;
    const r = await record(coA, msg);
    expect(r.created).toBe(true);
    const row = (await db.query(`select * from inbound_reviews where id=$1`, [r.review_id])).rows[0];
    expect(row.company_id).toBe(coA);
    expect(row.state).toBe("open");
    expect(row.reason_code).toBe("no_finance_classifier");
    expect(row.actor_type).toBe("staff");
    expect(row.body_excerpt).toContain("45,000");
  });

  it("REDELIVERY: recording the same message twice yields ONE row and the original", async () => {
    const msg = `wamid.${rnd()}`;
    const first = await record(coA, msg);
    const again = await record(coA, msg, "staff_other", { detail: "different reason, same message" });
    expect(again.created).toBe(false);
    expect(again.review_id).toBe(first.review_id);
    const n = (await db.query(`select count(*)::int c from inbound_reviews where company_id=$1 and provider_message_id=$2`, [coA, msg])).rows[0].c;
    expect(n).toBe(1);
    // The original reason is not rewritten by a later recording.
    const row = (await db.query(`select reason_code from inbound_reviews where id=$1`, [first.review_id])).rows[0];
    expect(row.reason_code).toBe("no_finance_classifier");
  });

  it("the same provider message id in ANOTHER company is a separate review", async () => {
    const msg = `wamid.${rnd()}`;
    const a = await record(coA, msg);
    const b = await record(coB, msg);
    expect(b.created).toBe(true);
    expect(b.review_id).not.toBe(a.review_id);
  });

  it("a reason code is REQUIRED — a review with no stated reason is not reviewable", async () => {
    await expect(record(coA, `wamid.${rnd()}`, "   ")).rejects.toThrow(/reason_code is required/);
    await expect(
      db.query(`select * from public.record_inbound_review($1,'whatsapp','','x',null,null,null,null,null,null)`, [coA]),
    ).rejects.toThrow(/provider_message_id is required/);
  });

  it("the body excerpt is BOUNDED — an adversarial message cannot fill the queue", async () => {
    const r = await record(coA, `wamid.${rnd()}`, "staff_other", { body: "x".repeat(50_000), detail: "y".repeat(5_000) });
    const row = (await db.query(`select body_excerpt, reason_detail from inbound_reviews where id=$1`, [r.review_id])).rows[0];
    expect(row.body_excerpt.length).toBe(500);
    expect(row.reason_detail.length).toBe(500);
  });

  it("a reviewer WITH the capability can close it, and the audit event lands in the same transaction", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    const res = (await db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved','called the supplier')`,
      [coA, r.review_id, reviewer])).rows[0];
    expect(res.state).toBe("resolved");
    const row = (await db.query(`select state, resolved_by, resolved_at, resolution_note from inbound_reviews where id=$1`, [r.review_id])).rows[0];
    expect(row.state).toBe("resolved");
    expect(row.resolved_by).toBe(reviewer);
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolution_note).toBe("called the supplier");
    const audit = (await db.query(
      `select payload from audit_events where action='inbound.review_resolved' and entity_id=$1`, [r.review_id])).rows[0];
    expect(audit.payload.state).toBe("resolved");
    expect(audit.payload.reason_code).toBe("no_finance_classifier");
  });

  it("a member WITHOUT the capability cannot close it — the DATABASE refuses, not just the app", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    await expect(
      db.query(`select * from public.resolve_inbound_review($1,$2,$3,'dismissed',null)`, [coA, r.review_id, bystander]),
    ).rejects.toMatchObject({ code: "42501" });
    const row = (await db.query(`select state from inbound_reviews where id=$1`, [r.review_id])).rows[0];
    expect(row.state).toBe("open");
  });

  it("a reviewer from ANOTHER company cannot close it", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    await expect(
      db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved',null)`, [coA, r.review_id, otherCoReviewer]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a review cannot be closed through the WRONG company's scope", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    await expect(
      db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved',null)`, [coB, r.review_id, otherCoReviewer]),
    ).rejects.toThrow(/not found in this company/);
  });

  it("a second decision does NOT overwrite the first", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    await db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved','handled')`, [coA, r.review_id, reviewer]);
    const second = (await db.query(`select * from public.resolve_inbound_review($1,$2,$3,'dismissed','never mind')`,
      [coA, r.review_id, reviewer])).rows[0];
    expect(second.state).toBe("resolved"); // the standing decision is returned, not replaced
    const row = (await db.query(`select state, resolution_note from inbound_reviews where id=$1`, [r.review_id])).rows[0];
    expect(row.state).toBe("resolved");
    expect(row.resolution_note).toBe("handled");
  });

  it("only resolved/dismissed are decisions — a row cannot be reopened or invented through the RPC", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    for (const bad of ["open", "deleted", "approved"]) {
      await expect(
        db.query(`select * from public.resolve_inbound_review($1,$2,$3,$4,null)`, [coA, r.review_id, reviewer, bad]),
      ).rejects.toThrow(/p_state must be resolved or dismissed/);
    }
  });

  it("a resolved row must name who decided — enforced by the table, not only the RPC", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    await expect(
      db.query(`update inbound_reviews set state='resolved' where id=$1`, [r.review_id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("both RPCs are service-only: an authenticated caller is refused 42501", async () => {
    const r = await record(coA, `wamid.${rnd()}`);
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      // Each refusal aborts the transaction, so each attempt gets its own savepoint — otherwise the
      // second assertion would only be observing 25P02 from the first.
      await db.query("savepoint a");
      await expect(db.query(`select * from public.record_inbound_review($1,'whatsapp','x','y',null,null,null,null,null,null)`, [coA]))
        .rejects.toMatchObject({ code: "42501" });
      await db.query("rollback to savepoint a");
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      await expect(db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved',null)`, [coA, r.review_id, reviewer]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });

  it("the queue is capability-gated for READING, not merely company-scoped", async () => {
    await record(coA, `wamid.${rnd()}`);
    const asUser = async (uid: string) => {
      await db.query("savepoint s");
      try {
        await db.query("set local role authenticated");
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
        // Scoped to ONE company: this file also creates rows in the other company, and a capable
        // reviewer there is SUPPOSED to see their own. The property under test is coA's rows.
        const n = (await db.query(`select count(*)::int c from inbound_reviews where company_id=$1`, [coA])).rows[0].c;
        await db.query("release savepoint s");
        return n;
      } catch (e) {
        await db.query("rollback to savepoint s");
        throw e;
      }
    };
    await db.query("begin");
    try {
      expect(await asUser(reviewer)).toBeGreaterThan(0);
      expect(await asUser(bystander)).toBe(0);       // in the company, but without the capability
      expect(await asUser(otherCoReviewer)).toBe(0); // capable, but in another company
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });
});
