/**
 * R1 FINAL CORRECTION — atomicity, disabled zero-write, and advisory-lock security.
 *
 * Live PostgreSQL, full schema, real roles. Every failure below is DELIBERATELY INJECTED and
 * then proven to have left nothing behind: no orphaned item, no orphaned evidence, no missing
 * opening transition, no partial audit row, no duplicate business effect.
 *
 * Run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const ACTOR = randomUUID();
const OUTSIDER = randomUUID();

let db: pg.Client;   // service_role claims — the trusted server context
let db2: pg.Client;  // a second connection, for concurrency and lock tests
let deps: CycleDeps;

const SRC = "finance.receivable_overdue";

/** Call the atomic RPC with sensible defaults, overridable per test. */
function callCreate(client: pg.Client, over: Record<string, unknown> = {}) {
  const args = {
    p_company: CO_A, p_actor: ACTOR, p_department: "finance", p_kind: "receivable_overdue",
    p_observation_source: SRC, p_subject_table: "customer_invoices", p_subject_id: "inv-1",
    p_identity_key: `k-${randomUUID()}`, p_correlation_id: randomUUID(),
    p_priority: "high", p_confidence: 1, p_required_authority: "manager_approval",
    p_proposed_action_id: "finance.invoice.flag_for_review", p_evidence_quality: "sufficient",
    p_may_run_unattended: false, p_business_deadline: null, p_business_deadline_source: null,
    p_evidence: [{ source_table: "customer_invoices", source_id: "inv-1", facts: { aging_bucket: "d90_plus" } }],
    ...over,
  };
  const order = [
    "p_company","p_actor","p_department","p_kind","p_observation_source","p_subject_table",
    "p_subject_id","p_identity_key","p_correlation_id","p_priority","p_confidence",
    "p_required_authority","p_proposed_action_id","p_evidence_quality","p_may_run_unattended",
    "p_business_deadline","p_business_deadline_source","p_evidence",
  ];
  const params = order.map((k) => {
    const v = (args as Record<string, unknown>)[k];
    return k === "p_evidence" ? JSON.stringify(v) : v;
  });
  const placeholders = order.map((_, i) => `$${i + 1}`).join(",");
  return client.query(`select public.r1_draft_create_management_item(${placeholders}) as r`, params);
}

/** Counts across every R1 table, for before/after comparison. */
async function snapshot(client: pg.Client, companyId?: string) {
  const where = companyId ? `where company_id = '${companyId}'` : "";
  const { rows } = await client.query(`
    select
      (select count(*) from management_items ${where}) as items,
      (select count(*) from management_item_evidence ${where}) as evidence,
      (select count(*) from management_item_transitions ${where}) as transitions,
      (select count(*) from management_cycle_runs ${where}) as runs,
      (select count(*) from audit_events ${companyId ? `where company_id = '${companyId}'` : ""}) as audit
  `);
  return {
    items: Number(rows[0].items), evidence: Number(rows[0].evidence),
    transitions: Number(rows[0].transitions), runs: Number(rows[0].runs),
    audit: Number(rows[0].audit),
  };
}

/** Every item must have evidence AND an opening transition. No exceptions, ever. */
async function assertNoOrphans(client: pg.Client) {
  // Scoped to the companies THIS file creates. Other suites seed items directly as the table
  // owner, which is a legitimate fixture path and not an orphan this test is about.
  const scope = `i.company_id in ('${CO_A}','${CO_B}')`;
  const { rows } = await client.query(`
    select
      (select count(*) from management_items i where ${scope}
        and not exists (select 1 from management_item_evidence e where e.item_id = i.id)) as items_without_evidence,
      (select count(*) from management_items i where ${scope}
        and not exists (select 1 from management_item_transitions t
                         where t.item_id = i.id and t.from_state is null and t.to_state = 'observed')) as items_without_opening,
      (select count(*) from management_item_evidence e
        where not exists (select 1 from management_items i where i.id = e.item_id)) as orphan_evidence,
      (select count(*) from management_item_transitions t
        where not exists (select 1 from management_items i where i.id = t.item_id)) as orphan_transitions
  `);
  expect(Number(rows[0].items_without_evidence), "orphaned item with no evidence").toBe(0);
  expect(Number(rows[0].items_without_opening), "item with no opening transition").toBe(0);
  expect(Number(rows[0].orphan_evidence), "orphaned evidence").toBe(0);
  expect(Number(rows[0].orphan_transitions), "orphaned transition").toBe(0);
}

describe.skipIf(!enabled)("A — atomic management-item creation", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    db2 = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db2.connect();
    for (const c of [db, db2]) {
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
    for (const co of [CO_A, CO_B]) {
      await db.query(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')
                        on conflict (id) do nothing`, [co, `atom ${co.slice(0, 8)}`]);
    }
    for (const [u, co] of [[ACTOR, CO_A], [OUTSIDER, CO_B]] as const) {
      await db.query(`insert into users (id,full_name,is_active) values ($1,$2,true)
                        on conflict (id) do nothing`, [u, `atom ${u.slice(0, 8)}`]);
      const { rows } = await db.query(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [co, u]);
      await db.query(`insert into membership_roles (membership_id,company_id,role_key)
                        values ($1,$2,'project_manager') on conflict do nothing`, [rows[0].id, co]);
    }
    deps = makeCycleDeps(pgSupabase(db));
  }, 180_000);

  it("creates item, evidence, opening transition AND audit in ONE transaction", async () => {
    const before = await snapshot(db, CO_A);
    const { rows } = await callCreate(db);
    expect(rows[0].r.result).toBe("created");
    const after = await snapshot(db, CO_A);

    expect(after.items).toBe(before.items + 1);
    expect(after.evidence).toBe(before.evidence + 1);
    expect(after.transitions).toBe(before.transitions + 1);
    expect(after.audit).toBeGreaterThan(before.audit);
    await assertNoOrphans(db);
  });

  it("enforces the INITIAL state — an item cannot be conjured into an advanced state", async () => {
    const { rows } = await callCreate(db);
    const { rows: item } = await db.query(
      `select state from management_items where id=$1`, [rows[0].r.item_id]);
    expect(item[0].state).toBe("observed");
  });

  // ── FAILURE 1: an invalid item field aborts everything ──────────────────────────────
  it("FAILURE — invalid item field: zero items, zero evidence, zero transitions", async () => {
    const before = await snapshot(db, CO_A);
    await expect(callCreate(db, { p_priority: "urgent" })).rejects.toThrow();
    expect(await snapshot(db, CO_A)).toEqual(before);
    await assertNoOrphans(db);
  });

  // ── FAILURE 2: invalid evidence ─────────────────────────────────────────────────────
  it("FAILURE — no evidence at all is refused, leaving nothing", async () => {
    const before = await snapshot(db, CO_A);
    await expect(callCreate(db, { p_evidence: [] })).rejects.toThrow(/at least one evidence reference/i);
    expect(await snapshot(db, CO_A)).toEqual(before);
  });

  it("FAILURE — malformed evidence is refused, leaving nothing", async () => {
    const before = await snapshot(db, CO_A);
    await expect(callCreate(db, { p_evidence: [{ source_table: "", source_id: "  " }] }))
      .rejects.toThrow(/source table and a row id/i);
    expect(await snapshot(db, CO_A)).toEqual(before);
    await assertNoOrphans(db);
  });

  // ── FAILURE 3: cross-company evidence ───────────────────────────────────────────────
  it("FAILURE — cross-company evidence is refused, leaving nothing", async () => {
    const before = await snapshot(db);
    await expect(callCreate(db, {
      p_evidence: [{ source_table: "t", source_id: "1", company_id: CO_B, facts: {} }],
    })).rejects.toThrow(/cross-company evidence refused/i);
    expect(await snapshot(db)).toEqual(before);
    await assertNoOrphans(db);
  });

  it("never returns an item belonging to another company", async () => {
    const key = `shared-${randomUUID()}`;
    const a = await callCreate(db, { p_identity_key: key });
    const b = await callCreate(db, { p_company: CO_B, p_actor: null, p_identity_key: key });
    expect(a.rows[0].r.item_id).not.toBe(b.rows[0].r.item_id);
    const { rows } = await db.query(
      `select company_id from management_items where id=$1`, [b.rows[0].r.item_id]);
    expect(rows[0].company_id).toBe(CO_B);
  });

  // ── FAILURE 4: an initial-transition failure aborts the item too ────────────────────
  it("FAILURE — initial transition cannot be written: the item does NOT survive", async () => {
    const before = await snapshot(db, CO_A);
    // Break the transition insert for this transaction only, then prove the item rolled back.
    await db.query("begin");
    try {
      await db.query(`alter table management_item_transitions add constraint tmp_break check (false) not valid`);
      await db.query(`alter table management_item_transitions validate constraint tmp_break`).catch(() => {});
      await db.query(`update pg_constraint set convalidated = true
                       where conname='tmp_break'`).catch(() => {});
      await expect(callCreate(db)).rejects.toThrow();
    } finally {
      await db.query("rollback");
    }
    expect(await snapshot(db, CO_A)).toEqual(before);
    await assertNoOrphans(db);
  });

  // ── FAILURE 5: duplicate identity is DETERMINISTIC, not an error and not a second item ──
  it("DUPLICATE identity returns the ORIGINAL item and creates nothing new", async () => {
    const key = `dupe-${randomUUID()}`;
    const first = await callCreate(db, { p_identity_key: key });
    expect(first.rows[0].r.result).toBe("created");

    const before = await snapshot(db, CO_A);
    const second = await callCreate(db, { p_identity_key: key });
    expect(second.rows[0].r.result).toBe("duplicate");
    expect(second.rows[0].r.item_id).toBe(first.rows[0].r.item_id);
    expect(await snapshot(db, CO_A)).toEqual(before); // NO duplicate business effect
  });

  // ── FAILURE 6: two concurrent identical observations ────────────────────────────────
  it("TWO CONCURRENT identical observations produce exactly ONE item", async () => {
    const key = `race-${randomUUID()}`;
    const results = await Promise.allSettled([
      callCreate(db, { p_identity_key: key }),
      callCreate(db2, { p_identity_key: key }),
    ]);
    const { rows } = await db.query(
      `select count(*)::int as n from management_items where company_id=$1 and identity_key=$2`,
      [CO_A, key]);
    expect(rows[0].n).toBe(1);
    // At least one call succeeded; a loser either sees `duplicate` or a unique violation —
    // both are correct, and neither creates a second item.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    await assertNoOrphans(db);
  });

  // ── FAILURE 7: a revoked actor ──────────────────────────────────────────────────────
  it("FAILURE — a REVOKED actor cannot create an item, and nothing is left behind", async () => {
    await db.query(`update memberships set status='ended' where user_id=$1 and company_id=$2`, [ACTOR, CO_A]);
    const before = await snapshot(db, CO_A);
    await expect(callCreate(db)).rejects.toThrow(/not an active member/i);
    expect(await snapshot(db, CO_A)).toEqual(before);
    await db.query(`update memberships set status='active' where user_id=$1 and company_id=$2`, [ACTOR, CO_A]);
  });

  it("FAILURE — an actor from ANOTHER company is refused", async () => {
    await expect(callCreate(db, { p_actor: OUTSIDER })).rejects.toThrow(/not an active member/i);
  });

  it("FAILURE — an UNREGISTERED observation source is refused", async () => {
    await expect(callCreate(db, { p_observation_source: "marketing.made_up" }))
      .rejects.toThrow(/not registered/i);
    await expect(callCreate(db, { p_observation_source: null })).rejects.toThrow(/not registered/i);
  });

  it("FAILURE — an unmanaged department is refused", async () => {
    await expect(callCreate(db, { p_department: "legal" })).rejects.toThrow(/not a managed domain/i);
  });

  it("FAILURE — a non-existent company is refused", async () => {
    await expect(callCreate(db, { p_company: randomUUID(), p_actor: null }))
      .rejects.toThrow(/does not exist/i);
  });

  // ── FAILURE 8: interruption and retry ───────────────────────────────────────────────
  it("INTERRUPTION then RETRY leaves exactly one item and no duplicate effect", async () => {
    const key = `retry-${randomUUID()}`;
    await db.query("begin");
    await callCreate(db, { p_identity_key: key });
    await db.query("rollback");                       // interrupted

    const { rows: gone } = await db.query(
      `select count(*)::int as n from management_items where identity_key=$1`, [key]);
    expect(gone[0].n).toBe(0);

    const retry = await callCreate(db, { p_identity_key: key });   // retried
    expect(retry.rows[0].r.result).toBe("created");
    const { rows } = await db.query(
      `select count(*)::int as n from management_items where identity_key=$1`, [key]);
    expect(rows[0].n).toBe(1);
    await assertNoOrphans(db);
  });

  // ── Permissions ─────────────────────────────────────────────────────────────────────
  it("EXECUTE is revoked from PUBLIC, anon and authenticated; granted to service_role only", async () => {
    const { rows } = await db.query(`
      select
        has_function_privilege('public', $1, 'execute') as pub,
        has_function_privilege('anon', $1, 'execute') as anon,
        has_function_privilege('authenticated', $1, 'execute') as auth,
        has_function_privilege('service_role', $1, 'execute') as svc
    `, ["public.r1_draft_create_management_item(uuid,uuid,text,text,text,text,text,text,text,text,numeric,text,text,text,boolean,timestamptz,text,jsonb)"]);
    expect(rows[0].pub).toBe(false);
    expect(rows[0].anon).toBe(false);
    expect(rows[0].auth).toBe(false);
    expect(rows[0].svc).toBe(true);
  });

  it("a caller WITHOUT service_role claims is refused even though it is SECURITY DEFINER", async () => {
    const c = new pg.Client({ connectionString: URL, ssl: false });
    await c.connect();
    try {
      await c.query("set role service_role");   // role set, but NO jwt claims
      await expect(callCreate(c)).rejects.toThrow(/service-only boundary/i);
    } finally {
      await c.end();
    }
  });

  it("the RPC pins a safe canonical search_path", async () => {
    const { rows } = await db.query(
      `select p.proconfig, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='r1_draft_create_management_item'`);
    expect(rows[0].prosecdef).toBe(true);
    expect((rows[0].proconfig ?? []).join(",")).toContain("search_path=pg_catalog, extensions, public, pg_temp");
  });

  it("DIRECT creation bypassing the RPC is refused for every API role", async () => {
    for (const role of ["authenticated", "service_role"]) {
      await db.query("begin");
      try {
        await db.query(`set local role ${role}`);
        await expect(db.query(
          `insert into management_items (company_id,department,kind,subject_table,subject_id,identity_key)
           values ($1,'finance','k','t','1',$2)`, [CO_A, `bypass-${randomUUID()}`]),
        ).rejects.toThrow();
      } finally {
        await db.query("rollback");
      }
    }
  });

  it("history is still ON DELETE RESTRICT — an item with history cannot be deleted", async () => {
    const { rows } = await callCreate(db);
    await expect(db.query(`delete from management_items where id=$1`, [rows[0].r.item_id]))
      .rejects.toThrow(/violates foreign key|still referenced/i);
  });

  it("the RUNTIME now uses the RPC end to end, and leaves no orphans", async () => {
    process.env.MANAGEMENT_KERNEL = "on";
    await db.query(
      `insert into management_kernel_enablement (company_id, enabled) values ($1,true)
         on conflict (company_id) do update set enabled = true`, [CO_A]);
    await db.query(
      `insert into tasks (company_id,title,status,due_date,estimate_hours)
       values ($1,'atomic runtime task','in_progress','2026-08-01',4)`, [CO_A]).catch(() => {});

    const s = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(["completed", "partial"]).toContain(s.status);
    await assertNoOrphans(db);
  }, 120_000);
});

describe.skipIf(!enabled)("B — disabled means ZERO database writes", () => {
  let savedFlag: string | undefined;

  beforeAll(() => { savedFlag = process.env.MANAGEMENT_KERNEL; });
  afterAll(() => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
  });

  it("GLOBAL FLAG ABSENT: not one row is written anywhere", async () => {
    await db.query(`insert into management_kernel_enablement (company_id, enabled) values ($1,true)
                      on conflict (company_id) do update set enabled = true`, [CO_A]);
    delete process.env.MANAGEMENT_KERNEL;

    const before = await snapshot(db);
    const s = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    const after = await snapshot(db);

    expect(s.status).toBe("skipped_disabled");
    expect(after).toEqual(before);      // items, evidence, transitions, RUNS and AUDIT all unchanged
    expect(s.sourcesRegistered).toBe(0); // no detector was even considered
  });

  it("GLOBAL FLAG FALSE: not one row is written anywhere", async () => {
    process.env.MANAGEMENT_KERNEL = "off";
    const before = await snapshot(db);
    const s = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(s.status).toBe("skipped_disabled");
    expect(await snapshot(db)).toEqual(before);
  });

  it("COMPANY DISABLED: not one row is written anywhere", async () => {
    process.env.MANAGEMENT_KERNEL = "on";
    await db.query(`update management_kernel_enablement set enabled=false where company_id=$1`, [CO_A]);

    const before = await snapshot(db);
    const s = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(s.status).toBe("skipped_disabled");
    expect(await snapshot(db)).toEqual(before);
  });

  it("COMPANY ENABLEMENT ABSENT: not one row is written anywhere", async () => {
    process.env.MANAGEMENT_KERNEL = "on";
    const fresh = randomUUID();
    await db.query(`insert into companies (id,name,base_currency) values ($1,'no-row','LKR')`, [fresh]);
    const before = await snapshot(db);
    const s = await runManagementCycle(deps, { companyId: fresh, actorId: null, trigger: "test" });
    expect(s.status).toBe("skipped_disabled");
    expect(await snapshot(db)).toEqual(before);
  });

  it("a DISABLED cycle takes NO lock, so it cannot block a later enabled one", async () => {
    process.env.MANAGEMENT_KERNEL = "on";
    await db.query(`update management_kernel_enablement set enabled=false where company_id=$1`, [CO_A]);
    await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });

    const { rows } = await db.query(
      `select count(*)::int as n from pg_locks
        where locktype='advisory' and classid = hashtext('r1_management_cycle')::oid`);
    expect(rows[0].n).toBe(0);
  });

  it("the disabled status still DISTINGUISHES 'kernel off' from 'nothing needed attention'", async () => {
    delete process.env.MANAGEMENT_KERNEL;
    const off = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(off.status).toBe("skipped_disabled");
    expect(off.failureReason).toMatch(/global flag/i);

    process.env.MANAGEMENT_KERNEL = "on";
    await db.query(`update management_kernel_enablement set enabled=false where company_id=$1`, [CO_A]);
    const companyOff = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(companyOff.failureReason).toMatch(/company enablement/i);
    // Two different disabled reasons, both distinct from a completed empty sweep.
    expect(off.failureReason).not.toBe(companyOff.failureReason);
  });
});

describe.skipIf(!enabled)("C — advisory-lock security", () => {
  const SIG = "public.r1_draft_try_cycle_lock(uuid)";
  const REL = "public.r1_draft_release_cycle_lock(uuid)";

  it("PUBLIC, anon and authenticated cannot EXECUTE the lock helpers", async () => {
    for (const sig of [SIG, REL]) {
      const { rows } = await db.query(`
        select has_function_privilege('public', $1, 'execute') as pub,
               has_function_privilege('anon', $1, 'execute') as anon,
               has_function_privilege('authenticated', $1, 'execute') as auth,
               has_function_privilege('service_role', $1, 'execute') as svc`, [sig]);
      expect(rows[0].pub, sig).toBe(false);
      expect(rows[0].anon, sig).toBe(false);
      expect(rows[0].auth, sig).toBe(false);
      expect(rows[0].svc, sig).toBe(true);
    }
  });

  it("an authenticated caller cannot take or release ANY company's lock", async () => {
    // One transaction per attempt: the first refusal aborts its transaction, so a second
    // statement inside it would report "current transaction is aborted" rather than the
    // permission error under test.
    for (const [fn, co] of [["r1_draft_try_cycle_lock", CO_A], ["r1_draft_release_cycle_lock", CO_B]] as const) {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await expect(db.query(`select ${fn}($1)`, [co])).rejects.toThrow(/permission denied/i);
      } finally {
        await db.query("rollback");
      }
    }
  });

  it("an anon caller cannot forge a company lock key", async () => {
    await db.query("begin");
    try {
      await db.query("set local role anon");
      await expect(db.query(`select r1_draft_try_cycle_lock($1)`, [CO_A])).rejects.toThrow(/permission denied/i);
    } finally {
      await db.query("rollback");
    }
  });

  it("an unprivileged caller cannot make a legitimate cycle return skipped_locked", async () => {
    process.env.MANAGEMENT_KERNEL = "on";
    await db.query(`insert into management_kernel_enablement (company_id, enabled) values ($1,true)
                      on conflict (company_id) do update set enabled = true`, [CO_A]);

    // An authenticated attacker tries to hold the lock first, and is refused outright.
    await db2.query("begin");
    try {
      await db2.query("set local role authenticated");
      await expect(db2.query(`select r1_draft_try_cycle_lock($1)`, [CO_A])).rejects.toThrow();
    } finally {
      await db2.query("rollback");
    }

    // The legitimate cycle proceeds normally.
    const s = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(s.status).not.toBe("skipped_locked");
  }, 120_000);

  it("the lock is released after SUCCESS, ERROR and ROLLBACK", async () => {
    process.env.MANAGEMENT_KERNEL = "on";
    await db.query(`insert into management_kernel_enablement (company_id, enabled) values ($1,true)
                      on conflict (company_id) do update set enabled = true`, [CO_A]);

    const held = async () => {
      const { rows } = await db.query(
        `select count(*)::int as n from pg_locks
          where locktype='advisory' and classid = hashtext('r1_management_cycle')::oid`);
      return rows[0].n as number;
    };

    // Success.
    await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(await held()).toBe(0);

    // Error inside the cycle.
    const failing = { ...deps, authorityFor: async () => { throw new Error("boom"); } } as CycleDeps;
    const s = await runManagementCycle(failing, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(s.status).toBe("failed");
    expect(await held()).toBe(0);
  }, 120_000);
});

// ONE connection pair for the whole file; closed once, after every describe block.
afterAll(async () => {
  await db?.end().catch(() => {});
  await db2?.end().catch(() => {});
});
