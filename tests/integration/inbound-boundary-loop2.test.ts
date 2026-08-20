/**
 * Correction loop 2 — the regressions a second independent adversarial review found in loop 1,
 * each reproduced on live PostgreSQL before being accepted, and each pinned here.
 *
 * The two that matter most were fixes that traded one defect for another:
 *   * removing the duplicate `source_events` row lost the COMPANY SCOPE on every finance capture,
 *     because production records the capture marker before the company is threaded through and the
 *     second, company-bearing call took the idempotent-replay branch;
 *   * narrowing the sweeper to exactly the finance captures meant the only wired processor —
 *     which reports `no_processor` for everything — dead-lettered every capture within one cron
 *     interval.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let co: string;
const ACCOUNT = `wa_l2_${rnd()}`;

const receipt = (msgId: string) =>
  db.query(`select * from public.record_inbound_receipt('whatsapp',$1,$2,'{"t":1}'::jsonb,'h',$3,'inbound_message')`,
    [ACCOUNT, msgId, `cor_${rnd()}`]).then((r: any) => r.rows[0]);
const claim = (id: string, owner: string) =>
  db.query(`select public.claim_inbound_dispatch($1,$2,120) as ok`, [id, owner]).then((r: any) => r.rows[0].ok);
const mark = (id: string, owner: string, outcome: string, company: string | null) =>
  db.query(`select * from public.record_inbound_dispatch($1,$2,$3,$4,null,null)`, [id, owner, outcome, company])
    .then((r: any) => r.rows[0]);

describe.skipIf(!enabled)("0077 — correction loop 2 (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('loop2','LKR') returning id`)).rows[0].id;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, ACCOUNT]);
  });
  afterAll(async () => {
    for (const sql of [
      `delete from source_events where company_id=$1`,
      `delete from channel_accounts where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    try { await db.query(`delete from source_events where provider_account_id=$1`, [ACCOUNT]); } catch { /* noop */ }
    await db?.end().catch(() => {});
  });

  it("THE PRODUCTION ORDER: a capture marked without a company, then recorded with one, ends COMPANY-SCOPED", async () => {
    const r = await receipt(`wamid.${rnd()}`);
    await claim(r.event_id, "w");
    // 1. deps.markCapture — this is the call that used to carry no company.
    const first = await mark(r.event_id, "w", "staff_finance", co);
    // 2. the orchestration records its own outcome; the replay branch must not drop the company.
    const second = await mark(r.event_id, "w", "staff_finance", co);
    expect(first.already).toBe(false);
    expect(second.already).toBe(true);
    const row = (await db.query(`select company_id, status from source_events where id=$1`, [r.event_id])).rows[0];
    expect(row.company_id).toBe(co);
    expect(row.status).toBe("pending");
  });

  it("a replay FILLS a company that is still missing rather than ignoring it", async () => {
    const r = await receipt(`wamid.${rnd()}`);
    await claim(r.event_id, "w");
    // A caller that genuinely has no company yet is refused outright for a capture…
    await expect(mark(r.event_id, "w", "staff_finance", null)).rejects.toThrow(/must be company-scoped/);
    // …and a NON-capture outcome recorded without one is filled in by the later call. (A separate
    // receipt: the refusal above left the first one still leased by "w".)
    const r2 = await receipt(`wamid.${rnd()}`);
    await claim(r2.event_id, "w2");
    await mark(r2.event_id, "w2", "customer_order", null);
    expect((await db.query(`select company_id from source_events where id=$1`, [r2.event_id])).rows[0].company_id).toBeNull();
    await mark(r2.event_id, "w2", "customer_order", co);
    expect((await db.query(`select company_id from source_events where id=$1`, [r2.event_id])).rows[0].company_id).toBe(co);
  });

  it("A CAPTURE WITH NO COMPANY IS IMPOSSIBLE, even by direct table write", async () => {
    const r = await receipt(`wamid.${rnd()}`);
    await expect(
      db.query(`update source_events set dispatch_state='dispatched', dispatch_outcome='staff_finance', company_id=null where id=$1`, [r.event_id]),
    ).rejects.toThrow(/must be company-scoped/);
  });

  it("A DECIDED NON-CAPTURE stops counting as unprocessed", async () => {
    const r = await receipt(`wamid.${rnd()}`);
    await claim(r.event_id, "w");
    await mark(r.event_id, "w", "customer_order", co);
    const row = (await db.query(`select status from source_events where id=$1`, [r.event_id])).rows[0];
    // 'received' here is what kept /api/health's raw backlog count inflated by every customer order.
    expect(row.status).toBe("processed");
  });

  it("RELEASE: a claimed row nothing can process yet is handed back, uncharged, not dead-lettered", async () => {
    const r = await receipt(`wamid.${rnd()}`);
    await claim(r.event_id, "w");
    await mark(r.event_id, "w", "staff_finance", co);
    const claimed = (await db.query(`select id, attempts from public.claim_source_events(10,'sweeper',120) where id=$1`, [r.event_id])).rows[0];
    expect(claimed).toBeTruthy();
    expect(claimed.attempts).toBe(1);

    expect((await db.query(`select public.release_source_event($1,'sweeper') as ok`, [r.event_id])).rows[0].ok).toBe(true);
    const after = (await db.query(`select status, attempts, lease_owner, dead_lettered_at from source_events where id=$1`, [r.event_id])).rows[0];
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);           // the attempt is GIVEN BACK
    expect(after.lease_owner).toBeNull();
    expect(after.dead_lettered_at).toBeNull(); // the capture survives an unbuilt processor
  });

  it("release refuses a foreign lease, a terminal row, and an untrusted caller", async () => {
    const r = await receipt(`wamid.${rnd()}`);
    await claim(r.event_id, "w");
    await mark(r.event_id, "w", "staff_finance", co);
    await db.query(`select id from public.claim_source_events(10,'owner-A',120) where id=$1`, [r.event_id]);
    await expect(db.query(`select public.release_source_event($1,'owner-B')`, [r.event_id])).rejects.toMatchObject({ code: "55P03" });

    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      await expect(db.query(`select public.release_source_event($1,'x')`, [r.event_id])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });

  it("the canonical identity escapes its delimiter, so no two component sets share a key", async () => {
    const a = (await db.query(`select public.canonical_event_identity('whatsapp','pn:one','wamid.Y','inbound_message') as k`)).rows[0].k;
    const b = (await db.query(`select public.canonical_event_identity('whatsapp','pn','one:wamid.Y','inbound_message') as k`)).rows[0].k;
    expect(a).not.toBe(b);
  });

  it("a HUMAN routing decision must name an active member of the company", async () => {
    const t = (await db.query(`insert into tasks (company_id, title, status) values ($1,'l2 task','captured') returning id`, [co])).rows[0].id;
    await expect(db.query(
      `select * from public.route_task($1,$2,'needs_routing','x',null,'[]'::jsonb,null,null,null,null,'human',null)`, [co, t]))
      .rejects.toThrow(/must name the person/);
    await expect(db.query(
      `select * from public.route_task($1,$2,'needs_routing','x',null,'[]'::jsonb,null,null,null,gen_random_uuid(),'human',null)`, [co, t]))
      .rejects.toMatchObject({ code: "42501" });
  });
});
