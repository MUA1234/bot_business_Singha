/**
 * The actor boundary — live Postgres, ZERO-PERSISTENCE.
 *
 * WP17 (migration 0049) made the system-actor path "explicit and trust-bounded": an explicit
 * `service_role` JWT got actor_type='system' with no human actor. Security review 2 of FOUND-006
 * showed that the trust bound was the CLAIM TEXT, which the caller controls. Nine SECURITY DEFINER
 * finance RPCs — every one EXECUTE-able by `authenticated` — gated their capability check on the
 * resulting `v_type`, so `{"role":"service_role"}` skipped it entirely. Reproduced from a login
 * role holding no service membership at all: a 999,999 journal, posted, attributed to nobody.
 *
 * Migration 0086 deletes the branch. There is no role test left in `_resolve_actor`, so no claim
 * value selects anything: the actor is the authenticated SUBJECT and the type is always 'user'.
 * These tests now assert THAT boundary — including, explicitly, that a forged `service_role`
 * claim buys nothing.
 *
 * `_resolve_actor` EXECUTE is revoked from PUBLIC; these tests call it as the DB owner
 * (superuser) with different simulated JWT claims. The end-to-end exploit is re-run from a
 * GENUINE unprivileged login role in `found-006-caller-trust.test.ts`, which owns that machinery.
 * Unexpected errors are NOT swallowed — every rejection is asserted against a specific message.
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

describe.skipIf(!enabled)("the actor boundary (0049 → 0086) — live, zero-persistence", () => {
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

  it("1. a forged service_role claim carrying no subject is REFUSED (was: system actor)", async () => {
    await setClaims(`{"role":"service_role"}`);
    await expect(resolve(null)).rejects.toThrow(/without a subject/i);
  });

  it("2. a forged service_role claim carrying a subject resolves to that HUMAN, never to 'system'", async () => {
    await setClaims(JSON.stringify({ role: "service_role", sub: human }));
    expect(await resolve(null)).toEqual({ v_actor: human, v_type: "user" });
  });

  it("2b. the claimed role selects NOTHING — every role value resolves identically", async () => {
    const seen: Array<{ v_actor: string | null; v_type: string }> = [];
    for (const role of ["service_role", "authenticated", "anon", "wizard", "postgres"]) {
      await setClaims(JSON.stringify({ role, sub: human }));
      seen.push(await resolve(null));
    }
    // One distinct outcome across five different claimed roles. This is the property G-01 broke.
    expect(seen).toEqual(seen.map(() => ({ v_actor: human, v_type: "user" })));
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

  it("5. anonymous role → rejected (no subject to act as)", async () => {
    await setClaims(`{"role":"anon"}`);
    await expect(resolve(null)).rejects.toThrow(/without a subject/i);
  });

  it("6. unknown role → rejected (no subject to act as)", async () => {
    await setClaims(`{"role":"wizard"}`);
    await expect(resolve(null)).rejects.toThrow(/without a subject/i);
  });

  it("6b. a malformed subject is rejected rather than cast-crashing", async () => {
    await setClaims(`{"role":"authenticated","sub":"not-a-uuid"}`);
    await expect(resolve(null)).rejects.toThrow(/malformed subject/i);
  });

  it("7. authenticated with a matching p_by → resolves to the subject", async () => {
    await setClaims(JSON.stringify({ role: "authenticated", sub: human }));
    expect(await resolve(human)).toEqual({ v_actor: human, v_type: "user" });
  });

  it("8. authenticated with a mismatched p_by → rejected", async () => {
    await setClaims(JSON.stringify({ role: "authenticated", sub: human }));
    await expect(resolve(OTHER)).rejects.toThrow(/actor mismatch/i);
  });

  it("8b. a forged service_role claim can no longer stamp somebody else into the ledger", async () => {
    // Before 0086 the service path IGNORED p_by and wrote NULL. The anti-spoof rule now applies
    // to every caller, because there is no path that skips it.
    await setClaims(JSON.stringify({ role: "service_role", sub: human }));
    await expect(resolve(OTHER)).rejects.toThrow(/actor mismatch/i);
  });

  it("9. end-to-end: a forged service_role claim cannot post a journal without the capability", async () => {
    await setClaims(JSON.stringify({ role: "service_role", sub: human }));
    const lines = JSON.stringify([
      { account_code: "1000", debit: "100", credit: "0", description: "x" },
      { account_code: "4000", debit: "0", credit: "100", description: "x" },
    ]);
    // `human` holds no membership in this company, so the capability check — which the system
    // path used to skip entirely — now runs and refuses.
    await expect(
      q(`select public.post_manual_journal($1::uuid,'2026-07-15','LKR','wp17',$2::uuid,$3::jsonb,'wp17-key') as id`,
        [company, human, lines]),
    ).rejects.toThrow(/missing capability finance\.journal\.post/i);
    const je = await q(`select count(*)::int as n from journal_entries where company_id=$1`, [company]);
    expect(je.rows[0].n).toBe(0);
  });

  it("10. the same post SUCCEEDS for the same human once they genuinely hold the capability", async () => {
    // The discriminating half: 9 must fail because of the capability, not because posting broke.
    const m = (await q(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
      [company, human])).rows[0].id;
    await q(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'accountant')`, [m, company]);
    await setClaims(JSON.stringify({ role: "authenticated", sub: human }));
    const lines = JSON.stringify([
      { account_code: "1000", debit: "100", credit: "0", description: "x" },
      { account_code: "4000", debit: "0", credit: "100", description: "x" },
    ]);
    const jid = (await q(
      `select public.post_manual_journal($1::uuid,'2026-07-15','LKR','wp17',$2::uuid,$3::jsonb,'wp17-ok') as id`,
      [company, human, lines])).rows[0].id;
    // The ledger now names the human who posted it — never NULL, never 'system'.
    const je = await q(`select posted_by from journal_entries where id=$1`, [jid]);
    expect(je.rows[0].posted_by).toBe(human);
    const au = await q(`select actor_type, actor_id from audit_events where entity_id::text=$1 and action='journal.posted'`, [jid]);
    expect(au.rows[0].actor_type).toBe("user");
    expect(au.rows[0].actor_id).toBe(human);
  });
});
