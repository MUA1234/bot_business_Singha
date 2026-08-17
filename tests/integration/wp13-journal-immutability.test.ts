/**
 * WP13 — posted-journal immutability (allowlist whole-row + immutable lines). Live Postgres,
 * ZERO-PERSISTENCE.
 *
 * Proves migration 0050:
 *  - a posted journal's header is immutable except for three exact, allowlisted transitions
 *    (reverse; link reversing entry; one-time fingerprint upgrade). ANY other column change is
 *    rejected — including fields the previous subset comparison silently permitted
 *    (exchange_rate, correlation_id, idempotency_key, source_event_id, posted_at, created_by, …);
 *  - a posted journal cannot be deleted;
 *  - posted journal LINES cannot be updated, deleted OR inserted;
 *  - the legitimate reversal transition still works end-to-end;
 *  - the legacy fingerprint upgrade is one-time (a set fingerprint can't be replaced).
 *
 * Triggers fire regardless of role, so these mutations are attempted as the DB owner. A mutation
 * that SUCCEEDS is a WP13 failure; a rejection must be the immutability error (any other error is
 * rethrown, never swallowed).
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string, jid: string, legacyJid: string, lineId: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try {
    const r = await client.query(sql, params);
    await client.query("release savepoint s");
    return r;
  } catch (e) {
    await client.query("rollback to savepoint s");
    throw e;
  }
}
/** True iff the write was rejected by the immutability guard. Rethrows any other error. */
async function blocked(sql: string, params: unknown[] = []): Promise<boolean> {
  await client.query("savepoint p");
  try {
    await client.query(sql, params);
    await client.query("rollback to savepoint p");
    return false; // the mutation SUCCEEDED — a WP13 failure
  } catch (e: unknown) {
    await client.query("rollback to savepoint p");
    if (/immutable/i.test((e as Error).message)) return true;
    throw e; // unexpected (not the immutability guard)
  }
}
const LINES = JSON.stringify([
  { account_code: "1000", debit: "100", credit: "0", description: "x" },
  { account_code: "4000", debit: "0", credit: "100", description: "x" },
]);
const post = async (memo: string, key: string): Promise<string> =>
  (await q(`select public.post_manual_journal($1::uuid,'2026-07-15','LKR',$2,null,$3::jsonb,$4) as id`, [company, memo, LINES, key])).rows[0].id;

describe.skipIf(!enabled)("WP13 posted-journal immutability — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`); // posting runs on the service path
    company = (await client.query(`insert into companies (name, base_currency) values ('wp13','LKR') returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'4000','Sales','income')`, [company]);
    jid = await post("wp13", "WP13-A");
    lineId = (await q(`select id from journal_lines where journal_id=$1 limit 1`, [jid])).rows[0].id;
    // Legacy posted journal (idem_fingerprint NULL): seed as draft, add lines, flip to posted.
    legacyJid = (await q(
      `insert into journal_entries (company_id, posting_date, currency, memo, status, correlation_id, idempotency_key, total_debit, total_credit, posted_at)
       values ($1,'2026-07-15','LKR','legacy','draft','corr_leg','WP13-LEG',100,100, now()) returning id`, [company])).rows[0].id;
    await q(`insert into journal_lines (journal_id, company_id, account_code, debit, credit, line_no) values ($1,$2,'1000',100,0,1),($1,$2,'4000',0,100,2)`, [legacyJid, company]);
    await q(`update journal_entries set status='posted' where id=$1`, [legacyJid]);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("a posted journal cannot be deleted", async () => {
    expect(await blocked(`delete from journal_entries where id=$1`, [jid])).toBe(true);
  });

  it("header fields the old subset trigger permitted are now blocked (whole-row allowlist)", async () => {
    const mutations: Array<[string, unknown[]]> = [
      [`update journal_entries set exchange_rate=2 where id=$1`, [jid]], // previously mutable
      [`update journal_entries set correlation_id='hacked' where id=$1`, [jid]], // previously mutable
      [`update journal_entries set idempotency_key='hacked' where id=$1`, [jid]], // previously mutable
      [`update journal_entries set source_event_id=gen_random_uuid() where id=$1`, [jid]], // previously mutable
      [`update journal_entries set posted_at=now() + interval '1 day' where id=$1`, [jid]], // previously mutable
      [`update journal_entries set created_by=gen_random_uuid() where id=$1`, [jid]], // previously mutable
      [`update journal_entries set memo='hacked' where id=$1`, [jid]],
      [`update journal_entries set posting_date='2020-01-01' where id=$1`, [jid]],
      [`update journal_entries set currency='USD' where id=$1`, [jid]],
      [`update journal_entries set posted_by=gen_random_uuid() where id=$1`, [jid]],
    ];
    for (const [sql, params] of mutations) {
      expect(await blocked(sql, params), sql).toBe(true);
    }
  });

  it("posted journal lines cannot be updated, deleted, or inserted", async () => {
    expect(await blocked(`update journal_lines set debit=5, credit=0 where id=$1`, [lineId])).toBe(true);
    expect(await blocked(`delete from journal_lines where id=$1`, [lineId])).toBe(true);
    expect(await blocked(`insert into journal_lines (journal_id, company_id, account_code, debit, credit, line_no) values ($1,$2,'1000',1,0,9)`, [jid, company])).toBe(true);
  });

  it("the legitimate reversal transition still works end-to-end", async () => {
    const target = await post("to-reverse", "WP13-REV");
    const rev = (await q(`select public.reverse_journal($1,$2,null,'2026-07-16','WP13-RKEY') as id`, [company, target])).rows[0].id;
    const orig = await q(`select status from journal_entries where id=$1`, [target]);
    expect(orig.rows[0].status).toBe("reversed"); // transition A
    const link = await q(`select reversal_of_journal_id from journal_entries where id=$1`, [rev]);
    expect(link.rows[0].reversal_of_journal_id).toBe(target); // transition B
  });

  it("legacy fingerprint upgrade is one-time (a set fingerprint cannot be replaced)", async () => {
    // NULL -> value : allowed
    await q(`update journal_entries set idem_fingerprint='v3:abc' where id=$1`, [legacyJid]);
    // value -> different : rejected (already set)
    expect(await blocked(`update journal_entries set idem_fingerprint='v3:xyz' where id=$1`, [legacyJid])).toBe(true);
    // a modern journal already carries a fingerprint → any change rejected
    expect(await blocked(`update journal_entries set idem_fingerprint='v3:z' where id=$1`, [jid])).toBe(true);
  });
});
