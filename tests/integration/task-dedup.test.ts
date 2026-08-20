/**
 * AIM-002 — durable task identity and deduplication, against live PostgreSQL.
 *
 * The defect: the management-case idempotency key hashes the whole transcript, so every new inbound
 * message produced a new case, the model re-detected the same follow-up, and the same task was
 * inserted again — violating "a duplicate event must never create a duplicate task".
 *
 * Two concerns are kept apart on purpose. EXACT identity is enforced by a unique index over a
 * SERVER-COMPUTED fingerprint, so a replay or a concurrent worker cannot create a second task.
 * SEMANTIC similarity is only ever a suggestion: similar text about different customers, assets or
 * dates is different work and is never merged automatically.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any, cA: any, cB: any, authed: any;
let coA: string, coB: string;

const RPC = `select * from create_task_deduplicated($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
/**
 * `??` would turn an EXPLICIT null into the default, which silently made a "no identity" case into
 * a fully-identified one. Presence of the key is what decides, so a test can pass null on purpose.
 */
const pick = (o: Record<string, unknown>, k: string, dflt: unknown) => (k in o ? o[k] : dflt);
const mk = (c: any, company: string, title: string, o: Partial<Record<string, unknown>> = {}) =>
  c.query(RPC, [
    company, title,
    pick(o, "sourceType", "wa_message"), pick(o, "sourceId", "wamid.1"), pick(o, "purpose", "order_replacement"),
    pick(o, "target", "customer:c1"), pick(o, "window", null), pick(o, "caseId", null),
    pick(o, "evidence", false), pick(o, "by", null),
  ]);

if (enabled) {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const conn = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    db = await conn(); cA = await conn(); cB = await conn(); authed = await conn();
    for (const c of [db, cA, cB]) await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await authed.query(`select set_config('request.jwt.claims','{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111"}',false)`);
    coA = (await db.query(`insert into companies (name, base_currency) values ('dedup_A','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('dedup_B','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => {
    for (const co of [coA, coB]) {
      try { await db.query(`delete from task_duplicate_suggestions where company_id=$1`, [co]); } catch { /* noop */ }
      try { await db.query(`delete from tasks where company_id=$1`, [co]); } catch { /* noop */ }
      try { await db.query(`delete from companies where id=$1`, [co]); } catch { /* noop */ }
    }
    await Promise.all([cA?.end(), cB?.end(), authed?.end(), db?.end()].map((p: any) => p?.catch?.(() => {})));
  });
}

describe.skipIf(!enabled)("AIM-002 exact identity (live DB)", () => {
  it("an exact replay returns the ORIGINAL task and creates nothing", async () => {
    const first = await mk(db, coA, "Order replacement gate", { sourceId: "wamid.replay" });
    expect(first.rows[0].created).toBe(true);
    const second = await mk(db, coA, "Order replacement gate (reworded)", { sourceId: "wamid.replay" });
    expect(second.rows[0].created).toBe(false);
    expect(second.rows[0].task_id).toBe(first.rows[0].task_id);

    const n = await db.query(`select count(*)::int n from tasks where company_id=$1 and source_id='wamid.replay'`, [coA]);
    expect(n.rows[0].n).toBe(1);
  });

  it("two CONCURRENT connections with the same identity produce exactly one task", async () => {
    const sid = "wamid.race." + randomUUID().slice(0, 8);
    const [a, b] = await Promise.all([
      mk(cA, coA, "Concurrent A", { sourceId: sid }),
      mk(cB, coA, "Concurrent B", { sourceId: sid }),
    ]);
    expect(a.rows[0].task_id).toBe(b.rows[0].task_id);
    expect([a.rows[0].created, b.rows[0].created].filter(Boolean)).toHaveLength(1);
    const n = await db.query(`select count(*)::int n from tasks where company_id=$1 and source_id=$2`, [coA, sid]);
    expect(n.rows[0].n).toBe(1);
  });

  it("a retry after an uncertain commit result is safe — no second task, no error", async () => {
    const sid = "wamid.uncertain." + randomUUID().slice(0, 8);
    const first = await mk(db, coA, "Uncertain", { sourceId: sid });
    // The worker never saw the result and retries.
    const retry = await mk(db, coA, "Uncertain", { sourceId: sid });
    expect(retry.rows[0].created).toBe(false);
    expect(retry.rows[0].task_id).toBe(first.rows[0].task_id);
  });

  it("the SAME provider id in a DIFFERENT company creates a separate task", async () => {
    const sid = "wamid.shared." + randomUUID().slice(0, 8);
    const a = await mk(db, coA, "Company A work", { sourceId: sid });
    const b = await mk(db, coB, "Company B work", { sourceId: sid });
    expect(a.rows[0].task_id).not.toBe(b.rows[0].task_id);
    expect(b.rows[0].created).toBe(true);
  });

  it("the same message arriving through a DIFFERENT channel is a different source and a new task", async () => {
    const sid = "msg." + randomUUID().slice(0, 8);
    const wa = await mk(db, coA, "Via WhatsApp", { sourceType: "wa_message", sourceId: sid });
    const em = await mk(db, coA, "Via email", { sourceType: "email_message", sourceId: sid });
    expect(wa.rows[0].task_id).not.toBe(em.rows[0].task_id);
  });

  it("identity is normalised — case and whitespace do not create a second task", async () => {
    const sid = "wamid.norm." + randomUUID().slice(0, 8);
    const a = await mk(db, coA, "Normalised", { sourceId: sid, purpose: "Order Replacement" });
    const b = await mk(db, coA, "Normalised", { sourceId: sid, purpose: "  order   replacement  " });
    expect(b.rows[0].created).toBe(false);
    expect(b.rows[0].task_id).toBe(a.rows[0].task_id);
  });
});

describe.skipIf(!enabled)("AIM-002 distinct work is never merged", () => {
  it("the same purpose for DIFFERENT customers is different work", async () => {
    const sid = "wamid.cust." + randomUUID().slice(0, 8);
    const a = await mk(db, coA, "Replace gate", { sourceId: sid, target: "customer:aaa" });
    const b = await mk(db, coA, "Replace gate", { sourceId: sid, target: "customer:bbb" });
    expect(a.rows[0].task_id).not.toBe(b.rows[0].task_id);
    expect(b.rows[0].created).toBe(true);
  });

  it("RECURRING work in a new occurrence window is a NEW task", async () => {
    const a = await mk(db, coA, "Weekly stock count", { sourceType: "schedule", sourceId: "weekly-stock", purpose: "stock_count", window: "2026-W34" });
    const b = await mk(db, coA, "Weekly stock count", { sourceType: "schedule", sourceId: "weekly-stock", purpose: "stock_count", window: "2026-W35" });
    expect(a.rows[0].task_id).not.toBe(b.rows[0].task_id);
    expect(b.rows[0].created).toBe(true);
    // …but the same window twice is still one task.
    const again = await mk(db, coA, "Weekly stock count", { sourceType: "schedule", sourceId: "weekly-stock", purpose: "stock_count", window: "2026-W35" });
    expect(again.rows[0].created).toBe(false);
  });

  it("ONE source event may legitimately create several DIFFERENT purposes", async () => {
    const sid = "wamid.multi." + randomUUID().slice(0, 8);
    const a = await mk(db, coA, "Arrange replacement", { sourceId: sid, purpose: "order_replacement" });
    const b = await mk(db, coA, "Refund the customer", { sourceId: sid, purpose: "issue_refund" });
    const c = await mk(db, coA, "Call the customer", { sourceId: sid, purpose: "call_customer" });
    const ids = new Set([a.rows[0].task_id, b.rows[0].task_id, c.rows[0].task_id]);
    expect(ids.size).toBe(3);
  });

  it("a CANCELLED task does not block re-raising the same work", async () => {
    const sid = "wamid.cancel." + randomUUID().slice(0, 8);
    const a = await mk(db, coA, "Cancelled then re-raised", { sourceId: sid });
    await db.query(`update tasks set status='cancelled' where id=$1`, [a.rows[0].task_id]);
    const b = await mk(db, coA, "Cancelled then re-raised", { sourceId: sid });
    expect(b.rows[0].created).toBe(true);
    expect(b.rows[0].task_id).not.toBe(a.rows[0].task_id);
  });

  it("a similarity SUGGESTION never merges anything", async () => {
    const x = await mk(db, coA, "Deliver cement to site A", { sourceId: "s1." + randomUUID().slice(0, 6), target: "customer:x" });
    const y = await mk(db, coA, "Deliver cement to site B", { sourceId: "s2." + randomUUID().slice(0, 6), target: "customer:y" });
    await db.query(
      `insert into task_duplicate_suggestions (company_id, task_id, similar_task_id, similarity, reason)
       values ($1,$2,$3,0.910,'similar description')`,
      [coA, x.rows[0].task_id, y.rows[0].task_id],
    );
    const both = await db.query(`select status from tasks where id = any($1::uuid[])`, [[x.rows[0].task_id, y.rows[0].task_id]]);
    expect(both.rows).toHaveLength(2); // both still exist, neither merged
    const s = await db.query(`select resolution from task_duplicate_suggestions where task_id=$1`, [x.rows[0].task_id]);
    expect(s.rows[0].resolution).toBe("open"); // a human decides
  });
});

describe.skipIf(!enabled)("AIM-002 adversarial identity and authorization", () => {
  it("a caller cannot forge identity_hash — the server recomputes it on insert AND update", async () => {
    const sid = "wamid.forge." + randomUUID().slice(0, 8);
    const a = await mk(db, coA, "Forge attempt", { sourceId: sid });
    const real = (await db.query(`select identity_hash from tasks where id=$1`, [a.rows[0].task_id])).rows[0].identity_hash;

    await db.query(`update tasks set identity_hash='deadbeef' where id=$1`, [a.rows[0].task_id]);
    const after = (await db.query(`select identity_hash from tasks where id=$1`, [a.rows[0].task_id])).rows[0].identity_hash;
    expect(after).toBe(real); // the trigger overwrote the forged value
    expect(after).not.toBe("deadbeef");
  });

  it("a task with no deterministic identity is NOT deduplicated (refusing to guess)", async () => {
    // No purpose ⇒ null identity ⇒ two genuinely separate rows rather than a wrong merge.
    const a = await mk(db, coA, "No identity 1", { purpose: null, sourceId: null });
    const b = await mk(db, coA, "No identity 2", { purpose: null, sourceId: null });
    expect(a.rows[0].task_id).not.toBe(b.rows[0].task_id);
    const h = await db.query(`select identity_hash from tasks where id=$1`, [a.rows[0].task_id]);
    expect(h.rows[0].identity_hash).toBeNull();
  });

  it("oversized identity components are refused, not truncated into a collision", async () => {
    await expect(mk(db, coA, "Oversized", { sourceId: "x".repeat(600) })).rejects.toThrow();
    await expect(mk(db, coA, "Oversized", { purpose: "y".repeat(300) })).rejects.toThrow();
  });

  it("a missing company or empty title is refused", async () => {
    await expect(mk(db, null as any, "No company")).rejects.toThrow();
    await expect(mk(db, coA, "   ")).rejects.toThrow();
  });

  it("unauthorized roles cannot create a deduplicated task", async () => {
    await expect(mk(authed, coA, "By authenticated")).rejects.toThrow();
  });

  it("the RPC and both hash helpers are service-only", async () => {
    const r = await db.query(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') a,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') b
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and p.proname in ('create_task_deduplicated','task_identity_hash','normalize_identity_part')`);
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    // No untrusted role reaches any of them. The trigger is SECURITY DEFINER, so ordinary
    // capability-gated task creation still works without granting anything to authenticated —
    // an earlier revision granted the helpers instead and broke on `extensions` schema USAGE.
    for (const row of r.rows) {
      expect(row.a, `${row.proname} anon`).toBe(false);
      expect(row.b, `${row.proname} authenticated`).toBe(false);
    }
  });

  it("suggestions are not writable by anon or authenticated", async () => {
    const r = await db.query(`
      select has_table_privilege('authenticated','public.task_duplicate_suggestions','INSERT') i,
             has_table_privilege('anon','public.task_duplicate_suggestions','UPDATE') u`);
    expect(r.rows[0].i).toBe(false);
    expect(r.rows[0].u).toBe(false);
  });
});
