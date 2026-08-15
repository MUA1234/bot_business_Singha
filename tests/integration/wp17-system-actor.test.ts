/**
 * WP17 — explicit system-actor path. Live against real Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0049: a service/worker call (no JWT) can no longer stamp an arbitrary
 * human identity into the ledger or the audit trail. `_resolve_actor` ignores a
 * caller-supplied `p_by` on the service path and records a NULL human actor tagged
 * `actor_type = 'system'`; the authenticated path still derives the actor from `auth.uid()`
 * and rejects a mismatched `p_by`; anonymous callers are rejected.
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
async function setClaims(obj: Record<string, unknown> | null) {
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [obj ? JSON.stringify(obj) : ""]);
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

  it("service path: _resolve_actor ignores a caller-supplied human p_by → null system actor", async () => {
    await setClaims(null); // no JWT → service/worker path
    const r = await q(`select v_actor, v_type from _resolve_actor($1)`, [human]);
    expect(r.rows[0].v_actor).toBeNull(); // the human id was NOT recorded
    expect(r.rows[0].v_type).toBe("system");
  });

  it("anonymous caller is rejected", async () => {
    await setClaims({ role: "anon" });
    await expect(q(`select v_actor from _resolve_actor(null)`)).rejects.toThrow(/anonymous/i);
    await setClaims(null);
  });

  it("authenticated user: matching p_by resolves to auth.uid(); a mismatched p_by is rejected", async () => {
    await setClaims({ sub: human, role: "authenticated" });
    const ok = await q(`select v_actor, v_type from _resolve_actor($1)`, [human]);
    expect(ok.rows[0].v_actor).toBe(human);
    expect(ok.rows[0].v_type).toBe("user");
    await expect(q(`select v_actor from _resolve_actor($1)`, [OTHER])).rejects.toThrow(/actor mismatch/i);
    await setClaims(null);
  });

  it("service-path journal post records actor_type=system with NO human actor id (traceable via idempotency key)", async () => {
    await setClaims(null); // service/worker path
    const lines = JSON.stringify([
      { account_code: "1000", debit: "100", credit: "0", description: "x" },
      { account_code: "4000", debit: "0", credit: "100", description: "x" },
    ]);
    const jid = (
      await q(`select public.post_manual_journal($1::uuid,'2026-07-15','LKR','wp17',$2::uuid,$3::jsonb,'wp17-key') as id`, [company, human, lines])
    ).rows[0].id;

    const je = await q(`select posted_by from journal_entries where id=$1`, [jid]);
    expect(je.rows[0].posted_by).toBeNull(); // ledger not attributed to the passed human

    const au = await q(
      `select actor_type, actor_id, idempotency_key from audit_events where entity_id::text=$1 and action='journal.posted'`,
      [jid],
    );
    expect(au.rows.length).toBe(1);
    expect(au.rows[0].actor_type).toBe("system");
    expect(au.rows[0].actor_id).toBeNull(); // NOT falsely attributed to the human
    expect(au.rows[0].idempotency_key).toBe("wp17-key"); // correlation for traceability
  });
});
