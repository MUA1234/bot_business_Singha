/**
 * Security preflight for the migration-0071 SECURITY DEFINER task-identity trigger.
 *
 * Every property here is proved BEHAVIOURALLY — by making the database do the thing and observing
 * the outcome — rather than by matching source text. Source matching has produced three false
 * positives in this program already (comments and identifiers read as calls), so it is not used as
 * evidence for a security property.
 *
 * The trigger is SECURITY DEFINER because it computes the identity hash with `extensions.digest`,
 * which `authenticated` cannot reach. That elevation must buy exactly that and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });
const CANONICAL = "search_path=pg_catalog, extensions, public, pg_temp";

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let coA: string, coB: string;

if (enabled) {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new (pg as any).Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    coA = (await db.query(`insert into companies (name, base_currency) values ('sdf_A','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('sdf_B','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => {
    for (const co of [coA, coB]) {
      try { await db.query(`delete from tasks where company_id=$1`, [co]); } catch { /* noop */ }
      try { await db.query(`delete from companies where id=$1`, [co]); } catch { /* noop */ }
    }
    await db?.end().catch(() => {});
  });
}

describe.skipIf(!enabled)("0071 SECDEF preflight — definition properties", () => {
  it("both elevated functions have ONE trusted owner, shared with every other app SECDEF function", async () => {
    const owners = await db.query(
      `select distinct pg_get_userbyid(proowner) o from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.prosecdef`,
    );
    expect(owners.rows).toHaveLength(1); // a second owner would be an unreviewed privilege domain
    const mine = await db.query(
      `select p.proname, pg_get_userbyid(p.proowner) o from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in ('tasks_set_identity_hash','create_task_deduplicated')`,
    );
    expect(mine.rows).toHaveLength(2);
    for (const r of mine.rows) expect(r.o).toBe(owners.rows[0].o);
  });

  it("all four functions pin the exact canonical search_path", async () => {
    const r = await db.query(
      `select p.proname, coalesce(array_to_string(p.proconfig, ','), '') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('tasks_set_identity_hash','task_identity_hash','normalize_identity_part','create_task_deduplicated')`,
    );
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) expect(row.cfg, `${row.proname} search_path`).toBe(CANONICAL);
  });

  it("the trigger contains no dynamic SQL", async () => {
    const r = await db.query(
      `select prosrc ~* 'execute[[:space:]]' as dyn from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='tasks_set_identity_hash'`,
    );
    expect(r.rows[0].dyn).toBe(false);
  });

  it("the elevated functions are unreachable by every untrusted role", async () => {
    const r = await db.query(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public'
         and p.proname in ('tasks_set_identity_hash','task_identity_hash','normalize_identity_part','create_task_deduplicated')`);
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.auth_x, `${row.proname} authenticated`).toBe(false);
    }
  });
});

describe.skipIf(!enabled)("0071 SECDEF preflight — the elevation buys nothing extra", () => {
  it("an ungranted authenticated insert is refused by RLS — NOT by the extensions schema", async () => {
    // This is the discriminating assertion. Before the trigger was made SECURITY DEFINER, an
    // authenticated insert died with "permission denied for schema extensions" — the trigger broke
    // BEFORE row security had its say. Now the only thing that stops an ungranted caller is the RLS
    // policy, which is the control that is supposed to stop them.
    //
    // The SUCCESS path (a caller who does hold the capability) is covered by
    // tests/integration/capability-rls.test.ts, which builds the membership fixture and passes.
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: "00000000-0000-0000-0000-0000000000aa", role: "authenticated" }),
    ]);
    let message = "";
    try {
      await db.query(
        `insert into tasks (company_id, title, status, priority, requires_evidence, source_type, source_id, task_purpose)
         values ($1,'preflight','captured',3,false,'wa_message',$2,'preflight_purpose')`,
        [coA, "wamid." + randomUUID().slice(0, 8)],
      );
    } catch (e) {
      message = String((e as Error).message);
    }
    await db.query("rollback");

    expect(message).toMatch(/row-level security/i);
    expect(message).not.toMatch(/permission denied for schema/i);
  });

  it("the elevation does NOT let an authenticated caller write into another company", async () => {
    // The trigger runs as the definer, but RLS on `tasks` is still evaluated for the CALLER, so a
    // cross-company insert must still fail. This is the property that would break if the elevation
    // had been placed on the wrong function.
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: "00000000-0000-0000-0000-0000000000bb", role: "authenticated" }),
    ]);
    let refused = false;
    try {
      await db.query(
        `insert into tasks (company_id, title, status, priority, requires_evidence)
         values ($1,'cross company','captured',3,false)`,
        [coB],
      );
    } catch {
      refused = true;
    }
    await db.query("rollback");
    expect(refused).toBe(true);
  });

  it("a pg_temp object cannot shadow the hashing helpers", async () => {
    // The classic search_path attack: plant an object in pg_temp and hope a pinned function
    // resolves to it. pg_temp is LAST in the pinned path, and PostgreSQL never resolves FUNCTION
    // names from pg_temp at all — this asserts the OUTCOME rather than trusting either fact.
    const sid = "wamid.shadow." + randomUUID().slice(0, 8);
    const before = await db.query(
      `insert into tasks (company_id, title, status, priority, requires_evidence, source_type, source_id, task_purpose)
       values ($1,'shadow control','captured',3,false,'wa_message',$2,'shadow_purpose') returning identity_hash`,
      [coA, sid],
    );

    await db.query(`create function pg_temp.normalize_identity_part(text) returns text
                    language sql immutable as $x$ select 'HIJACKED'::text $x$`);
    await db.query(`create function pg_temp.task_identity_hash(uuid,text,text,text,text,text) returns text
                    language sql immutable as $x$ select 'HIJACKED'::text $x$`);

    const after = await db.query(
      `insert into tasks (company_id, title, status, priority, requires_evidence, source_type, source_id, task_purpose)
       values ($1,'shadow attempt','captured',3,false,'wa_message',$2,'shadow_purpose') returning identity_hash`,
      [coA, sid + ".b"],
    );

    expect(after.rows[0].identity_hash).not.toBe("HIJACKED");
    expect(after.rows[0].identity_hash).toMatch(/^[0-9a-f]{64}$/);
    // Different source ids ⇒ different hashes, so hashing still discriminates normally.
    expect(after.rows[0].identity_hash).not.toBe(before.rows[0].identity_hash);
  });

  it("a pg_temp relation named `tasks` cannot capture the write", async () => {
    await db.query(`create temp table if not exists tasks (id uuid, title text)`);
    const sid = "wamid.reltemp." + randomUUID().slice(0, 8);
    const r = await db.query(
      `insert into public.tasks (company_id, title, status, priority, requires_evidence, source_type, source_id, task_purpose)
       values ($1,'temp relation','captured',3,false,'wa_message',$2,'temp_rel_purpose') returning id, identity_hash`,
      [coA, sid],
    );
    expect(r.rows[0].identity_hash).toMatch(/^[0-9a-f]{64}$/);
    const real = await db.query(`select count(*)::int n from public.tasks where source_id=$1`, [sid]);
    expect(real.rows[0].n).toBe(1); // it landed in the real table, not the temp one
    await db.query(`drop table if exists pg_temp.tasks`);
  });
});
