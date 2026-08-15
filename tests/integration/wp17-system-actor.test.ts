/**
 * WP17 — explicit, trust-bounded system-actor path. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0049: the system path is reachable ONLY by an explicit `service_role`
 * JWT. Everything else is rejected fail-closed. A service call records no human actor
 * (actor_id NULL, actor_type='system') and ignores any caller-supplied `p_by`, so a worker
 * can never stamp a human identity into the ledger/audit trail. The authenticated-user path
 * still derives the actor from the JWT subject and rejects a mismatched `p_by`.
 *
 * `_resolve_actor` EXECUTE is revoked from PUBLIC; these tests call it as the DB owner
 * (superuser) with different simulated JWT claims. Unexpected errors are NOT swallowed —
 * every rejection is asserted against a specific message.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string, human: string;
const OTHER = "22222222-2222-2222-2222-222222222222";

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
/** Set request.jwt.claims to a RAW string (so we can simulate missing / malformed / any role). */
async function setClaims(raw: string) {
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [raw]);
}
async function resolve(pBy: string | null): Promise<{ v_actor: string | null; v_type: string }> {
  const r = await q(`select v_actor, v_type from _resolve_actor($1)`, [pBy]);
  return r.rows[0];
}

describe.skipIf(!enabled)("WP17 system-actor path — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    company = (await client.query(`insert into companies (name, base_currency) values ('wp17','LKR') returning id`)).rows[0].id;
    human = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp17_human',true) returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'4000','Sales','income')`, [company]);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("1. explicit service_role → null system actor", async () => {
    await setClaims(`{"role":"service_role"}`);
    expect(await resolve(null)).toEqual({ v_actor: null, v_type: "system" });
  });

  it("2. service_role: a caller-supplied human p_by is ignored", async () => {
    await setClaims(`{"role":"service_role"}`);
    expect(await resolve(human)).toEqual({ v_actor: null, v_type: "system" }); // NOT the human
  });

  it("3. missing JWT claims → rejected", async () => {
    await setClaims("");
    await expect(resolve(null)).rejects.toThrow(/missing JWT claims/i);
  });

  it("3b. malformed JWT claims → rejected", async () => {
    await setClaims("{not json");
    await expect(resolve(null)).rejects.toThrow(/malformed JWT claims/i);
  });

  it("4. authenticated role without a subject → rejected", async () => {
    await setClaims(`{"role":"authenticated"}`);
    await expect(resolve(null)).rejects.toThrow(/without a subject/i);
  });

  it("5. anonymous role → rejected", async () => {
    await setClaims(`{"role":"anon"}`);
    await expect(resolve(null)).rejects.toThrow(/not permitted/i);
  });

  it("6. unknown role → rejected", async () => {
    await setClaims(`{"role":"wizard"}`);
    await expect(resolve(null)).rejects.toThrow(/not permitted/i);
  });

  it("7. authenticated with a matching p_by → resolves to the subject", async () => {
    await setClaims(JSON.stringify({ role: "authenticated", sub: human }));
    expect(await resolve(human)).toEqual({ v_actor: human, v_type: "user" });
  });

  it("8. authenticated with a mismatched p_by → rejected", async () => {
    await setClaims(JSON.stringify({ role: "authenticated", sub: human }));
    await expect(resolve(OTHER)).rejects.toThrow(/actor mismatch/i);
  });

  it("9. end-to-end: a service_role journal post records NO human actor", async () => {
    await setClaims(`{"role":"service_role"}`);
    const lines = JSON.stringify([
      { account_code: "1000", debit: "100", credit: "0", description: "x" },
      { account_code: "4000", debit: "0", credit: "100", description: "x" },
    ]);
    // p_by is a real human uuid; it must be ignored on the service path.
    const jid = (
      await q(`select public.post_manual_journal($1::uuid,'2026-07-15','LKR','wp17',$2::uuid,$3::jsonb,'wp17-key') as id`, [company, human, lines])
    ).rows[0].id;
    const je = await q(`select posted_by from journal_entries where id=$1`, [jid]);
    expect(je.rows[0].posted_by).toBeNull();
    const au = await q(`select actor_type, actor_id, idempotency_key from audit_events where entity_id::text=$1 and action='journal.posted'`, [jid]);
    expect(au.rows.length).toBe(1);
    expect(au.rows[0].actor_type).toBe("system");
    expect(au.rows[0].actor_id).toBeNull();
    expect(au.rows[0].idempotency_key).toBe("wp17-key");
  });
});
