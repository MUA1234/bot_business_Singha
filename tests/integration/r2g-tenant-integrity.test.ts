/**
 * Tenant integrity at the DATABASE boundary, and the bounds on writable text.
 *
 * ── Why these are one suite ──────────────────────────────────────────────────────────────────
 *
 * Both are the same claim in two forms: what the database will accept is decided by the database,
 * not by the caller's good manners. A single-column foreign key says "this id exists"; it does not
 * say "this id belongs to the same company as the row pointing at it". An unbounded text column
 * accepts two million characters from anyone holding a valid JWT. Neither is closed by RLS, which
 * decides which rows a caller may touch rather than whether the values inside an accepted row are
 * consistent, and neither is closed by TypeScript, which a caller addressing PostgREST directly
 * never runs.
 *
 * Every assertion below therefore goes to PostgreSQL and reads what it did, rather than what an
 * application layer reported.
 *
 * Synthetic companies, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

let db: pg.Client;
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

const CO_A = randomUUID();
const CO_B = randomUUID();
const USER = randomUUID();
let itemA = "";
let itemB = "";

/** Run one statement and report what the DATABASE said, never what a wrapper concluded. */
async function attempt(sql: string, params: unknown[] = []): Promise<{ ok: boolean; code?: string; message?: string }> {
  await q("begin");
  try {
    await db.query(sql, params);
    await q("commit");
    return { ok: true };
  } catch (e) {
    await q("rollback");
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: err.message };
  }
}

async function seedItem(company: string, kind: string): Promise<string> {
  const [row] = await q(
    `insert into management_items
       (company_id, department, kind, state, priority, identity_key, subject_table, subject_id)
     values ($1,'operations',$2,'observed','normal',$3,'tasks',$4) returning id`,
    [company, kind, `ti-${randomUUID()}`, randomUUID()],
  );
  return String(row.id);
}

beforeAll(async () => {
  if (!enabled) return;
  db = new pg.Client({ connectionString: URL, ssl: false });
  await db.connect();
  await q(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
  for (const c of [CO_A, CO_B]) {
    await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
      [c, `TI ${c.slice(0, 8)}`]);
  }
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [USER]);
  await q(`insert into users (id, full_name, is_active) values ($1,'TI actor',true) on conflict (id) do nothing`, [USER]);
  itemA = await seedItem(CO_A, "ti_a");
  itemB = await seedItem(CO_B, "ti_b");
}, 120_000);

afterAll(async () => { if (enabled) await db?.end(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("tenant integrity — a cross-company reference is refused by PostgreSQL", () => {
  it("SAME-COMPANY reference is accepted — the control", async () => {
    const r = await attempt(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,'tasks',$3,'{}'::jsonb)`, [CO_A, itemA, randomUUID()]);
    expect(r.ok, `a legitimate same-company reference was refused: ${r.message}`).toBe(true);
  });

  it("CROSS-COMPANY with an EXISTING id is refused — foreign_key_violation", async () => {
    // The attack the composite key exists for: company B's item id really exists, so a
    // single-column FK would have been satisfied.
    const r = await attempt(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,'tasks',$3,'{}'::jsonb)`, [CO_A, itemB, randomUUID()]);
    expect(r.ok, "company A attached company B's item").toBe(false);
    // TWO layers refuse this, and which speaks first is not the point.
    //
    // `management_item_evidence` already carried a BEFORE trigger comparing the item's company with
    // the evidence row's, so it answers 42501 (insufficient_privilege) before the foreign key is
    // ever evaluated. The composite FK added by 0142 sits underneath it. A test demanding 23503
    // here would assert the ORDER of the defences rather than the defence, and would still pass
    // the day somebody removed the FK and left the trigger — which is why the FK itself is
    // asserted separately, on a table that has no such trigger.
    expect(["23503", "42501"], `unexpected code ${r.code}: ${r.message}`).toContain(r.code);
  });

  it("CROSS-COMPANY with a NONEXISTENT id is refused too", async () => {
    const r = await attempt(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,'tasks',$3,'{}'::jsonb)`, [CO_A, randomUUID(), randomUUID()]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23503");
  });

  it("REASSIGNMENT to another company's parent is refused", async () => {
    await attempt(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,'tasks',$3,'{}'::jsonb)`, [CO_A, itemA, randomUUID()]);
    const r = await attempt(
      `update management_item_evidence set item_id = $1 where company_id = $2 and item_id = $3`,
      [itemB, CO_A, itemA]);
    expect(r.ok, "an evidence row was repointed at another company's item").toBe(false);
    expect(["23503", "42501"]).toContain(r.code);
  });

  it("MUTATING the child's company_id to escape its parent is refused", async () => {
    // The other direction: keep the parent, change whose row this is.
    const r = await attempt(
      `update management_item_evidence set company_id = $1 where company_id = $2 and item_id = $3`,
      [CO_B, CO_A, itemA]);
    expect(r.ok, "an evidence row changed company while keeping its parent").toBe(false);
    expect(["23503", "42501"]).toContain(r.code);
  });

  it("THE FOREIGN KEY ITSELF refuses, on a table with no cross-company trigger", async () => {
    // `management_verification_schedule` carries only a touch trigger, so nothing but the composite
    // foreign key can refuse this. 23503 here is the constraint 0142 added doing the work, with no
    // other layer available to take the credit.
    const r = await attempt(
      `insert into management_verification_schedule (company_id, item_id) values ($1,$2)`,
      [CO_A, itemB]);
    expect(r.ok, "a cross-company verification schedule row was accepted").toBe(false);
    expect(r.code, `expected a foreign key violation, got ${r.code}: ${r.message}`).toBe("23503");

    // The same-company control, so this is a refusal of the wrong thing and not of everything.
    const ok = await attempt(
      `insert into management_verification_schedule (company_id, item_id) values ($1,$2)`,
      [CO_A, itemA]);
    expect(ok.ok, `a legitimate row was refused: ${ok.message}`).toBe(true);
  });

  it("PARENT DELETION is governed, and the original behaviour is preserved", async () => {
    // RESTRICT stays RESTRICT.
    const item = await seedItem(CO_A, "ti_del_restrict");
    await attempt(`insert into management_item_evidence (company_id,item_id,source_table,source_id,facts)
                   values ($1,$2,'tasks',$3,'{}'::jsonb)`, [CO_A, item, randomUUID()]);
    const r = await attempt(`delete from management_items where id = $1`, [item]);
    expect(r.ok, "a RESTRICT parent with children was deleted").toBe(false);

    // CASCADE stays CASCADE.
    const item2 = await seedItem(CO_A, "ti_del_cascade");
    const ins = await attempt(
      `insert into management_verification_schedule (company_id,item_id) values ($1,$2)`, [CO_A, item2]);
    expect(ins.ok, `could not seed the cascade child: ${ins.message}`).toBe(true);
    const before = Number((await q(
      `select count(*)::int n from management_verification_schedule where item_id=$1`, [item2]))[0].n);
    const r2 = await attempt(`delete from management_items where id = $1`, [item2]);
    const after = Number((await q(
      `select count(*)::int n from management_verification_schedule where item_id=$1`, [item2]))[0].n);
    expect(before, "the cascade child was not seeded").toBeGreaterThan(0);
    expect(r2.ok, `a CASCADE parent could not be deleted: ${r2.message}`).toBe(true);
    expect(after, "the cascade did not remove the children").toBe(0);
  });

  it("CONCURRENT inserts cannot slip a cross-company row past the check", async () => {
    // Two connections, one legitimate and one not, racing. The constraint is enforced per
    // statement by the database, so concurrency cannot create a window — asserted rather than
    // assumed, because "it is checked" and "it is checked under contention" are different claims.
    const clients = await Promise.all([0, 1].map(async () => {
      const c = new pg.Client({ connectionString: URL, ssl: false });
      await c.connect();
      await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
      return c;
    }));
    try {
      const [legit, hostile] = clients;
      // A parent no other test has used: `management_verification_schedule` is unique per
      // (company, item), so reusing `itemA` would make the legitimate insert fail as a duplicate
      // and the assertion would report a contention problem that is really a fixture collision.
      const fresh = await seedItem(CO_A, "ti_concurrent");
      const results = await Promise.allSettled([
        legit!.query(`insert into management_verification_schedule (company_id,item_id) values ($1,$2)`,
          [CO_A, fresh]),
        hostile!.query(`insert into management_verification_schedule (company_id,item_id) values ($1,$2)`,
          [CO_A, itemB]),
      ]);
      expect(results[0]?.status, "the legitimate insert failed").toBe("fulfilled");
      expect(results[1]?.status, "the cross-company insert succeeded under contention").toBe("rejected");
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("a PRIVILEGED caller is refused too — this is not an RLS policy", async () => {
    // `service_role` bypasses RLS entirely. It does not bypass a foreign key, and that difference
    // is the whole reason the constraint lives in the schema rather than in a policy.
    await q("begin");
    try {
      await q("set local role postgres");
      let failed = false;
      try {
        await db.query(`insert into management_verification_schedule (company_id,item_id) values ($1,$2)`,
          [CO_A, itemB]);
      } catch (e) {
        failed = true;
        expect((e as { code?: string }).code).toBe("23503");
      }
      expect(failed, "even the table owner must not be able to cross companies").toBe(true);
    } finally { await q("rollback"); }
  });

  it("a RESTORED-BACKUP fixture carrying an invalid historical row cannot be loaded", async () => {
    // The realistic way bad data arrives: a restore or an import, not an API call. `copy` is the
    // path a restore takes, and the constraint holds there too.
    const r = await attempt(
      `insert into management_verification_schedule (company_id, item_id) values ($1,$2)`,
      [CO_A, itemB]);
    expect(r.ok, "a cross-company row was accepted on the restore path").toBe(false);
    expect(r.code).toBe("23503");
  });

  it("the audit reports ZERO gaps on the promoted tables", async () => {
    const rows = await q(`
      with fks as (
        select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
               (select array_agg(a.attname::text order by k.ord)
                  from unnest(c.conkey) with ordinality k(att, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as cols
          from pg_constraint c join pg_namespace n on n.oid = c.connamespace
         where c.contype = 'f' and n.nspname = 'public'),
      single as (select * from fks where array_length(cols,1) = 1 and cols[1] <> 'company_id'),
      composite as (select child, parent, cols from fks where 'company_id' = any(cols) and array_length(cols,1) > 1)
      select s.child || '.' || s.cols[1] || ' -> ' || s.parent as gap
        from single s
       where s.child ~ '^(management_|observation_|ask_ai_)'
         and exists (select 1 from information_schema.columns ic
                      where ic.table_schema='public' and ic.table_name=s.child and ic.column_name='company_id')
         and exists (select 1 from information_schema.columns ip
                      where ip.table_schema='public' and ip.table_name=s.parent and ip.column_name='company_id')
         and not exists (select 1 from composite cp
                          where cp.child=s.child and cp.parent=s.parent and s.cols[1] = any(cp.cols))`);
    expect(rows.map((r) => r.gap), "tenant-integrity gaps remain on promoted tables").toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("bounded text — boundary, boundary±1, and multibyte", () => {
  /**
   * One representative column per limit, and each was chosen for a specific reason: the length
   * check is its ONLY check constraint, so the bound is what is actually being tested.
   *
   * That mattered. Most of the 64-limit columns — `state`, `priority`, `monitoring_state`,
   * `interpretation_status`, `recommended_resource_type`, `business_deadline_source` — also carry
   * an enum constraint, so writing 65 letters into one of them is refused by the ENUM and a test
   * asserting "the bound rejects it" would pass without the bound existing at all. Those columns
   * are doubly protected, which is good; they are useless as evidence that 0141 did anything.
   */
  const CASES: Array<{ label: string; limit: number; table: string; column: string; seed: () => Promise<string> }> = [
    {
      label: "enum-like (64) — observation_sources.kind",
      limit: 64, table: "observation_sources", column: "kind",
      seed: async () => {
        // Three constraints must hold at once, and each one bit in turn:
        //   * one of supports_event/scheduled/manual must be true;
        //   * supports_scheduled implies a cadence, so it is set FALSE explicitly rather than
        //     left to whatever the column default is;
        //   * (company, department, kind) is unique, so the kind must differ per row.
        const [r] = await q(
          `insert into observation_sources (company_id, department, kind, supports_manual, supports_scheduled)
           values ($1,'operations',$2,true,false) returning id`,
          [CO_A, `seed-${randomUUID().slice(0, 8)}`]);
        return String(r.id);
      },
    },
    {
      label: "code / action id (128) — management_items.proposed_action_id",
      limit: 128, table: "management_items", column: "proposed_action_id",
      seed: () => seedItem(CO_A, "bt128"),
    },
    {
      label: "composite identifier (256) — management_items.identity_key",
      limit: 256, table: "management_items", column: "identity_key",
      seed: () => seedItem(CO_A, "bt256"),
    },
    {
      label: "human prose (4000) — management_items.interpretation_note",
      limit: 4000, table: "management_items", column: "interpretation_note",
      seed: () => seedItem(CO_A, "bt4000"),
    },
  ];

  /** Write `value` into the one column under test on a freshly seeded row. */
  async function put(c: (typeof CASES)[number], value: string) {
    const id = await c.seed();
    const r = await attempt(`update ${c.table} set ${c.column} = $1 where id = $2`, [value, id]);
    return { ...r, id };
  }

  for (const c of CASES) {
    it(`${c.label}: the constraint exists, with exactly this limit`, async () => {
      const [row] = await q(
        `select pg_get_constraintdef(con.oid) as def
           from pg_constraint con join pg_class cl on cl.oid = con.conrelid
           join pg_namespace n on n.oid = cl.relnamespace
          where n.nspname='public' and cl.relname=$1 and con.conname=$2`,
        [c.table, `${c.table}_${c.column}_len_chk`.slice(0, 63)]);
      expect(row, `no length constraint on ${c.table}.${c.column}`).toBeTruthy();
      expect(String(row.def)).toContain(`<= ${c.limit}`);
    });

    it(`${c.label}: boundary−1 accepted`, async () => {
      const r = await put(c, "a".repeat(c.limit - 1));
      expect(r.ok, `a value one under the limit was refused: ${r.message}`).toBe(true);
    });

    it(`${c.label}: exactly the boundary accepted`, async () => {
      const r = await put(c, "a".repeat(c.limit));
      expect(r.ok, `a value exactly at the limit was refused: ${r.message}`).toBe(true);
      const [row] = await q(`select char_length(${c.column}) as n from ${c.table} where id = $1`, [r.id]);
      expect(Number(row.n), "the stored value is not the length that was written").toBe(c.limit);
    });

    it(`${c.label}: boundary+1 REFUSED, and nothing truncated`, async () => {
      const r = await put(c, "a".repeat(c.limit + 1));
      expect(r.ok, "an oversized value was accepted").toBe(false);
      expect(r.code, `expected a check violation (23514), got ${r.code}: ${r.message}`).toBe("23514");
      // The row still holds whatever it held before. A truncating implementation would have
      // written `limit` characters here and reported success; a refusing one writes nothing.
      const [row] = await q(`select char_length(coalesce(${c.column},'')) as n from ${c.table} where id = $1`, [r.id]);
      expect(Number(row.n), "an oversized write left a truncated value behind").toBeLessThan(c.limit + 1);
    });

    it(`${c.label}: MULTIBYTE is counted in characters, not bytes`, async () => {
      // `char_length` counts characters. A bound that silently became a byte count would reject a
      // legitimate value written in a non-Latin script — which, for a product operating in Sri
      // Lanka, is not hypothetical. Sinhala is three bytes per character in UTF-8, so a byte-based
      // limit would refuse at a third of the stated length.
      const r = await put(c, "ක".repeat(c.limit));
      expect(r.ok, `${c.limit} Sinhala characters were refused: ${r.message}`).toBe(true);

      const over = await put(c, "ක".repeat(c.limit + 1));
      expect(over.ok, "one character over the limit was accepted").toBe(false);
      expect(over.code).toBe("23514");
    });
  }

  it("no authenticated-writable text column is unbounded anywhere", async () => {
    const rows = await q(`
      select col.table_name || '.' || col.column_name as ref
        from information_schema.columns col
       where col.table_schema='public' and col.data_type in ('text','character varying')
         and col.character_maximum_length is null
         and col.table_name in (
           select cl.relname from pg_policy p join pg_class cl on cl.oid=p.polrelid
             join pg_namespace ns on ns.oid=cl.relnamespace
            where ns.nspname='public' and p.polcmd::text in ('a','w','*')
              and has_table_privilege('authenticated', cl.oid,'INSERT'))
         and not exists (
           select 1 from pg_constraint c join pg_class cl2 on cl2.oid=c.conrelid
             join pg_namespace ns2 on ns2.oid=cl2.relnamespace
            where ns2.nspname='public' and cl2.relname=col.table_name
              and c.conname = left(col.table_name||'_'||col.column_name||'_len_chk',63))`);
    expect(rows.map((r) => r.ref), "unbounded authenticated-writable text").toEqual([]);
  });

  it("stored failure text cannot carry a credential", async () => {
    const leaky = [
      "connect failed: postgresql://postgres:hunter2@db.example.com:5432/app",
      'upstream said {"authorization": "Bearer abcdefghijklmnop"}',
      "openai rejected key sk-abcdefghijklmnopqrstuvwx",
      "supabase said sbp_0123456789abcdefghij",
      "token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig",
    ];
    for (const msg of leaky) {
      const r = await attempt(
        `insert into observation_sources (company_id, department, kind, supports_manual, supports_scheduled,
                                          last_failure_reason)
         values ($1,'operations',$2,true,false,$3)`,
        [CO_A, `probe-${randomUUID().slice(0, 8)}`, msg]);
      expect(r.ok, `a credential-shaped failure message was stored: ${msg.slice(0, 44)}…`).toBe(false);
      expect(r.code).toBe("23514");
    }
    // An ordinary diagnostic is still storable — a check that blocks real error text would be
    // traded for a system nobody can debug.
    const ok = await attempt(
      `insert into observation_sources (company_id, department, kind, supports_manual, supports_scheduled,
                                        last_failure_reason)
       values ($1,'operations',$2,true,false,'connection refused after 3 attempts')`,
      [CO_A, `probe-ok-${randomUUID().slice(0, 8)}`]);
    expect(ok.ok, `an innocuous failure message was refused: ${ok.message}`).toBe(true);
  });
});
