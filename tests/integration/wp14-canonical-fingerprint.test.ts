/**
 * WP14 — canonical-JSON idempotency fingerprints. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0051: the fingerprint is a versioned canonical JSONB object (v3), so a
 * delimiter inside a memo/description can no longer make two distinct payloads collide to one
 * fingerprint. Line order is insignificant (sorted). v2 fingerprints are compared with the v2
 * algorithm and never replaced; legacy NULL fingerprints reconstruct + upgrade once to v3.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { authClaims, seedCapableActor, TEST_ACTOR } from "./helpers/capable-actor";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string;

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
async function call(sql: string, params: unknown[] = []): Promise<{ ok: boolean; value?: string; error?: string }> {
  try {
    const r = await q(sql, params);
    return { ok: true, value: r.rows[0]?.v };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
const post = (memo: string, key: string, lines: unknown): [string, unknown[]] =>
  [`select public.post_manual_journal($1::uuid,'2026-07-15','LKR',$2,null,$3::jsonb,$4) as v`, [co, memo, JSON.stringify(lines), key]];
const L = (acct: string, d: number, c: number, desc = "x") => ({ account_code: acct, debit: String(d), credit: String(c), description: desc });
const BAL = [L("1000", 100, 0), L("4000", 0, 100)];

describe.skipIf(!enabled)("WP14 canonical-JSON fingerprint — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '${authClaims()}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('wp14','LKR') returning id`)).rows[0].id;
    await seedCapableActor(client, co);
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'4000','Sales','income')`, [co]);
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("a delimiter collision under the old scheme is distinguished under v3", async () => {
    // A = two lines; B = one line whose description contains the other line's old serialization.
    // The old `,`/`;`-joined string is identical; the canonical JSON is not.
    const A = JSON.stringify([L("1000", 1, 2, "x"), L("4000", 3, 4, "y")]);
    const B = JSON.stringify([L("1000", 1, 2, "x;4000,3.00,4.00,y")]);
    const r = await q(
      `select public._fp_lines($1::jsonb) = public._fp_lines($2::jsonb) as old_collides,
              public._fp_lines_v3($1::jsonb) = public._fp_lines_v3($2::jsonb) as v3_collides`,
      [A, B],
    );
    expect(r.rows[0].old_collides).toBe(true); // the vulnerability existed
    expect(r.rows[0].v3_collides).toBe(false); // …and is fixed
  });

  it("the same canonical payload returns the same journal (idempotent)", async () => {
    const a = await call(...post("m", "SAME", BAL));
    const b = await call(...post("m", "SAME", BAL));
    expect(a.ok && b.ok).toBe(true);
    expect(b.value).toBe(a.value);
  });

  it("reordered lines are the same payload (order is insignificant)", async () => {
    const a = await call(...post("m", "ORDER", [L("1000", 100, 0), L("4000", 0, 100)]));
    const b = await call(...post("m", "ORDER", [L("4000", 0, 100), L("1000", 100, 0)]));
    expect(b.value).toBe(a.value); // no conflict; same journal
  });

  it("a changed description (delimiter or not) on the same key is a conflict, not a silent reuse", async () => {
    const a = await call(...post("m", "DESC", [L("1000", 100, 0, "alpha"), L("4000", 0, 100, "beta")]));
    expect(a.ok).toBe(true);
    const b = await call(...post("m", "DESC", [L("1000", 100, 0, "alpha;4000,0.00,100.00,beta"), L("4000", 0, 100, "")]));
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/conflict/i);
  });

  it("different date or currency on the same key conflicts", async () => {
    await call(...post("m", "DC", BAL));
    expect((await call(`select public.post_manual_journal($1::uuid,'2026-07-16','LKR','m',null,$2::jsonb,'DC') as v`, [co, JSON.stringify(BAL)])).error).toMatch(/conflict/i);
    expect((await call(`select public.post_manual_journal($1::uuid,'2026-07-15','USD','m',null,$2::jsonb,'DC') as v`, [co, JSON.stringify(BAL)])).error).toMatch(/conflict/i);
  });

  it("an existing v2 fingerprint is compared with v2 and not replaced; a different payload conflicts", async () => {
    // Seed a journal stamped with the ORIGINAL v2 algorithm (as post_manual_journal would call it).
    const v2fp = (await q(
      `select public._fp_full('journal.manual_post',$1::uuid,null,null,'2026-07-15','LKR','v2',$2::jsonb) as fp`,
      [co, JSON.stringify(BAL)],
    )).rows[0].fp;
    const jid = (await q(
      `insert into journal_entries (company_id, posting_date, currency, memo, status, correlation_id, idempotency_key, total_debit, total_credit, posted_at, idem_fingerprint)
       values ($1,'2026-07-15','LKR','v2','draft','corr_v2','V2KEY',100,100, now(), $2) returning id`, [co, v2fp])).rows[0].id;
    await q(`insert into journal_lines (journal_id, company_id, account_code, debit, credit, line_no) values ($1,$2,'1000',100,0,1),($1,$2,'4000',0,100,2)`, [jid, co]);
    await q(`update journal_entries set status='posted' where id=$1`, [jid]);
    // Same payload + key → matched via v2 → returns the existing journal, fingerprint left as v2.
    const same = await call(...post("v2", "V2KEY", BAL));
    expect(same.value).toBe(jid);
    expect((await q(`select idem_fingerprint from journal_entries where id=$1`, [jid])).rows[0].idem_fingerprint).toBe(v2fp); // unchanged
    // Different payload + same key → v2 comparison differs → conflict.
    expect((await call(...post("v2-different", "V2KEY", BAL))).error).toMatch(/conflict/i);
  });

  it("a legacy NULL fingerprint reconstructs, matches, and upgrades once to v3", async () => {
    const jid = (await q(
      `insert into journal_entries (company_id, posting_date, currency, memo, status, correlation_id, idempotency_key, total_debit, total_credit, posted_at)
       values ($1,'2026-07-15','LKR','leg','draft','corr_leg','LEGKEY',100,100, now()) returning id`, [co])).rows[0].id;
    // descriptions match the request payload (BAL uses 'x') so reconstruction matches.
    await q(`insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no) values ($1,$2,'1000',100,0,'x',1),($1,$2,'4000',0,100,'x',2)`, [jid, co]);
    await q(`update journal_entries set status='posted' where id=$1`, [jid]);
    const same = await call(...post("leg", "LEGKEY", BAL));
    expect(same.value).toBe(jid);
    const fp = (await q(`select idem_fingerprint from journal_entries where id=$1`, [jid])).rows[0].idem_fingerprint;
    expect(fp).toMatch(/^v3:/); // upgraded once
  });
});
