/**
 * R1 draft schema — live PostgreSQL behavioural tests (checkpoint 2).
 *
 * Proves at the DATABASE boundary what `tests/kernel/lifecycle.test.ts` proves in pure code,
 * because an invariant enforced only in application code is a convention, not a control.
 *
 * Covers: the six-unit apply, the lifecycle map, illegal-transition refusal, GENUINE
 * two-connection concurrency, the zero-evidence prohibition, cross-company rejection,
 * append-only history, deadline provenance, and a full rollback leaving no R1 object behind.
 *
 * Skipped unless DATABASE_URL points at a disposable local database.
 * Run: see scripts/r1/run-draft-schema-tests.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const ACTOR = randomUUID();

let db: pg.Client;
let db2: pg.Client;

/** Insert an item directly (bypassing the kernel) so transitions can be tested in isolation. */
async function newItem(company = CO_A, state = "observed", kind = "receivable_overdue") {
  const id = randomUUID();
  await db.query(
    `insert into management_items (id, company_id, department, kind, subject_table, subject_id, identity_key, state)
     values ($1,$2,'finance',$3,'customer_invoices',$4,$5,$6)`,
    [id, company, kind, `inv-${id.slice(0, 8)}`, `${company}:${kind}:${id}`, state],
  );
  return id;
}

async function addEvidence(itemId: string, company = CO_A, sourceId = `src-${randomUUID().slice(0, 8)}`) {
  await db.query(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
     values ($1,$2,'customer_invoices',$3,'{"days_overdue":47}'::jsonb)`,
    [company, itemId, sourceId],
  );
}

const transition = (c: pg.Client, item: string, from: string, to: string, reason: string | null = null) =>
  c.query(`select r1_draft_transition_item($1,$2,$3,$4,'user',$5,'[]'::jsonb) as r`, [item, from, to, ACTOR, reason]);

describe.skipIf(!enabled)("R1 draft schema — live disposable PostgreSQL", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    db2 = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db2.connect();
    execFileSync("node", ["scripts/r1/draft-migrate.mjs", "--up"], {
      env: { ...process.env, R1_DRAFT_CONFIRM: "disposable-local-only" },
      stdio: "pipe",
    });
  }, 60_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    await db2?.end().catch(() => {});
  });

  it("creates all six R1 tables", async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name in
        ('management_items','management_item_transitions','management_item_evidence',
         'management_item_decisions','observation_sources','management_item_feedback')`,
    );
    expect(rows).toHaveLength(6);
  });

  it("records the draft units in its OWN ledger and never in schema_migrations", async () => {
    const { rows } = await db.query(`select count(*)::int as n from r1_draft_migrations`);
    expect(rows[0].n).toBe(6);

    // The strongest possible form of the assertion: applying every draft unit did not even
    // CREATE the production ledger, so it cannot have written to it. (If a future run does
    // create it — e.g. the drafts are applied on top of a real schema — fall through and
    // assert no draft row leaked into it.)
    const { rows: present } = await db.query(
      `select to_regclass('public.schema_migrations') is not null as exists`,
    );
    if (!present[0].exists) {
      expect(present[0].exists).toBe(false); // proven: production ledger untouched
      return;
    }
    const { rows: leaked } = await db.query(
      `select count(*)::int as n from schema_migrations where filename like 'R1_DRAFT%'`,
    );
    expect(leaked[0].n).toBe(0);
  });

  // ── lifecycle at the database boundary ───────────────────────────────────────────────
  it("walks the full happy path observed → verified", async () => {
    const id = await newItem();
    await addEvidence(id);
    const path = [
      ["observed", "understood"], ["understood", "prioritised"], ["prioritised", "recommended"],
      ["recommended", "awaiting_approval"], ["awaiting_approval", "approved"], ["approved", "assigned"],
      ["assigned", "monitoring"], ["monitoring", "verifying"], ["verifying", "verified"],
    ] as const;
    for (const [from, to] of path) {
      const r = await transition(db, id, from, to);
      expect(r.rows[0].r.result, `${from} -> ${to}`).toBe("transitioned");
    }
    const { rows } = await db.query(`select state, outcome from management_items where id=$1`, [id]);
    expect(rows[0].state).toBe("verified");
    expect(rows[0].outcome).toBe("resolved");
  });

  it("REFUSES an illegal transition", async () => {
    const id = await newItem();
    await addEvidence(id);
    await expect(transition(db, id, "observed", "assigned")).rejects.toThrow(/illegal management-item transition/i);
  });

  it("REFUSES any transition out of a terminal state", async () => {
    const id = await newItem();
    await transition(db, id, "observed", "dismissed", "noise");
    await expect(transition(db, id, "dismissed", "understood")).rejects.toThrow(/illegal/i);
  });

  it("REFUSES a dismissal with no reason — the reason is the learning signal", async () => {
    const id = await newItem();
    await expect(transition(db, id, "observed", "dismissed", null)).rejects.toThrow(/requires a reason/i);
    await expect(transition(db, id, "observed", "dismissed", "   ")).rejects.toThrow(/requires a reason/i);
  });

  it("reopens rather than verifying when re-observation still fails", async () => {
    const id = await newItem(CO_A, "verifying");
    await addEvidence(id);
    const r = await transition(db, id, "verifying", "reopened");
    expect(r.rows[0].r.result).toBe("transitioned");
    const { rows } = await db.query(`select state, outcome from management_items where id=$1`, [id]);
    expect(rows[0].state).toBe("reopened");
    expect(rows[0].outcome).toBeNull();
  });

  it("routes to needs_routing when no assignee can be recommended (R1-D-3)", async () => {
    const id = await newItem(CO_A, "recommended");
    await addEvidence(id);
    const r = await transition(db, id, "recommended", "needs_routing");
    expect(r.rows[0].r.result).toBe("transitioned");
    await db.query(
      `update management_items set routing_department='finance', routing_reason=$2, routing_requested_at=now() where id=$1`,
      [id, "no available finance officer with the required capability"],
    );
    const { rows } = await db.query(`select routing_reason from management_items where id=$1`, [id]);
    expect(rows[0].routing_reason).toMatch(/no available finance officer/);
  });

  // ── concurrency, with two REAL connections ───────────────────────────────────────────
  it("serialises two concurrent transitions — exactly one wins, the other reports a conflict", async () => {
    const id = await newItem();
    await addEvidence(id);

    await db.query("begin");
    const first = await transition(db, id, "observed", "understood");
    expect(first.rows[0].r.result).toBe("transitioned");

    // Second connection blocks on the row lock until the first commits.
    const racing = transition(db2, id, "observed", "understood");
    await new Promise((r) => setTimeout(r, 120));
    await db.query("commit");

    const second = await racing;
    expect(second.rows[0].r.result).toBe("conflict");
    expect(second.rows[0].r.expected).toBe("observed");
    expect(second.rows[0].r.actual).toBe("understood");

    const { rows } = await db.query(
      `select count(*)::int as n from management_item_transitions where item_id=$1`, [id],
    );
    expect(rows[0].n).toBe(1); // the loser wrote NOTHING
  }, 30_000);

  it("a stale expected-from is reported as a conflict, not silently applied", async () => {
    const id = await newItem();
    await addEvidence(id);
    await transition(db, id, "observed", "understood");
    const r = await transition(db, id, "observed", "understood"); // stale
    expect(r.rows[0].r.result).toBe("conflict");
  });

  it("reports not_found for an unknown item rather than throwing", async () => {
    const r = await transition(db, randomUUID(), "observed", "understood");
    expect(r.rows[0].r.result).toBe("not_found");
  });

  it("refuses two approve decisions from the same actor on one item", async () => {
    const id = await newItem();
    await db.query(
      `insert into management_item_decisions (company_id,item_id,decision,actor_id) values ($1,$2,'approve',$3)`,
      [CO_A, id, ACTOR],
    );
    await expect(
      db.query(`insert into management_item_decisions (company_id,item_id,decision,actor_id) values ($1,$2,'approve',$3)`,
        [CO_A, id, ACTOR]),
    ).rejects.toThrow(/duplicate key/i);
  });

  // ── zero evidence ────────────────────────────────────────────────────────────────────
  it("REFUSES recommendation with zero evidence", async () => {
    const id = await newItem(CO_A, "prioritised");
    await expect(transition(db, id, "prioritised", "recommended")).rejects.toThrow(/zero evidence/i);
  });

  it("permits recommendation once evidence exists", async () => {
    const id = await newItem(CO_A, "prioritised");
    await addEvidence(id);
    const r = await transition(db, id, "prioritised", "recommended");
    expect(r.rows[0].r.result).toBe("transitioned");
  });

  it("permits dismissal with zero evidence — an item can be noise", async () => {
    const id = await newItem(CO_A, "prioritised");
    const r = await transition(db, id, "prioritised", "dismissed", "not a real condition");
    expect(r.rows[0].r.result).toBe("transitioned");
  });

  // ── cross-company ────────────────────────────────────────────────────────────────────
  it("REFUSES evidence belonging to another company", async () => {
    const id = await newItem(CO_A);
    await expect(addEvidence(id, CO_B)).rejects.toThrow(/cross-company evidence refused/i);
  });

  it("REFUSES a decision belonging to another company", async () => {
    const id = await newItem(CO_A);
    await expect(
      db.query(`insert into management_item_decisions (company_id,item_id,decision,actor_id) values ($1,$2,'approve',$3)`,
        [CO_B, id, randomUUID()]),
    ).rejects.toThrow(/cross-company decision refused/i);
  });

  it("keeps two companies' items entirely separate", async () => {
    const a = await newItem(CO_A);
    const b = await newItem(CO_B);
    const { rows } = await db.query(`select id from management_items where company_id=$1`, [CO_B]);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(b);
    expect(ids).not.toContain(a);
  });

  // ── append-only history ──────────────────────────────────────────────────────────────
  it("REFUSES updating or deleting transition history", async () => {
    const id = await newItem();
    await addEvidence(id);
    await transition(db, id, "observed", "understood");
    await expect(db.query(`update management_item_transitions set to_state='verified' where item_id=$1`, [id]))
      .rejects.toThrow(/append-only/i);
    await expect(db.query(`delete from management_item_transitions where item_id=$1`, [id]))
      .rejects.toThrow(/append-only/i);
  });

  it("REFUSES rewriting evidence or feedback", async () => {
    const id = await newItem();
    await addEvidence(id);
    await expect(db.query(`update management_item_evidence set facts='{}'::jsonb where item_id=$1`, [id]))
      .rejects.toThrow(/append-only/i);
    await db.query(
      `insert into management_item_feedback (company_id,item_id,feedback_type,reason) values ($1,$2,'decision_reason','x')`,
      [CO_A, id],
    );
    await expect(db.query(`update management_item_feedback set reason='y' where item_id=$1`, [id]))
      .rejects.toThrow(/append-only/i);
  });

  it("preserves a complete audit chain from observation to outcome", async () => {
    const id = await newItem();
    await addEvidence(id);
    for (const [f, t] of [["observed","understood"],["understood","prioritised"],["prioritised","recommended"]] as const) {
      await transition(db, id, f, t);
    }
    const { rows } = await db.query(
      `select from_state, to_state, actor_type from management_item_transitions
        where item_id=$1 order by created_at`, [id],
    );
    expect(rows.map((r) => `${r.from_state}->${r.to_state}`)).toEqual([
      "observed->understood", "understood->prioritised", "prioritised->recommended",
    ]);
    expect(rows.every((r) => r.actor_type === "user")).toBe(true);
  });

  // ── deadline provenance (R1-D-4) ─────────────────────────────────────────────────────
  it("REFUSES a business deadline with no stated provenance", async () => {
    const id = await newItem();
    await expect(db.query(`update management_items set business_deadline=now() where id=$1`, [id]))
      .rejects.toThrow(/deadline_provenance/i);
  });

  it("accepts a deadline WITH provenance, and a review time WITH its policy", async () => {
    const id = await newItem();
    await db.query(
      `update management_items set business_deadline=now(), business_deadline_source='evidence',
              review_by=now(), review_policy_id='finance.default' where id=$1`, [id],
    );
    const { rows } = await db.query(`select business_deadline_source, review_policy_id from management_items where id=$1`, [id]);
    expect(rows[0].business_deadline_source).toBe("evidence");
    expect(rows[0].review_policy_id).toBe("finance.default");
  });

  it("REFUSES a review time with no configured policy — no fabricated review timing", async () => {
    const id = await newItem();
    await expect(db.query(`update management_items set review_by=now() where id=$1`, [id]))
      .rejects.toThrow(/review_provenance/i);
  });

  // ── observation-source registry (R1-D-5) ─────────────────────────────────────────────
  it("REFUSES a scheduled source with no cadence — no implicit polling interval", async () => {
    await expect(
      db.query(`insert into observation_sources (department,kind,supports_scheduled) values ('finance','x',true)`),
    ).rejects.toThrow(/cadence/i);
  });

  it("REFUSES a source reachable by no trigger mode", async () => {
    await expect(
      db.query(`insert into observation_sources (department,kind,supports_event,supports_scheduled,supports_manual)
                values ('finance','y',false,false,false)`),
    ).rejects.toThrow(/reachable/i);
  });

  it("allows a per-company cadence override alongside the default row", async () => {
    await db.query(`insert into observation_sources (company_id,department,kind,supports_scheduled,cadence_seconds)
                    values (null,'finance','cadence_test',true,3600)`);
    await db.query(`insert into observation_sources (company_id,department,kind,supports_scheduled,cadence_seconds)
                    values ($1,'finance','cadence_test',true,300)`, [CO_A]);
    const { rows } = await db.query(
      `select cadence_seconds from observation_sources where kind='cadence_test' order by cadence_seconds`);
    expect(rows.map((r) => r.cadence_seconds)).toEqual([300, 3600]);
  });

  it("records a failed scan so a department reports UNOBSERVED rather than all-clear", async () => {
    await db.query(`insert into observation_sources (department,kind,supports_scheduled,cadence_seconds,
                      last_failure_at,last_failure_reason,consecutive_failures)
                    values ('system','probe',true,900,now(),'connection refused',3)`);
    const { rows } = await db.query(
      `select last_failure_reason, consecutive_failures from observation_sources where kind='probe'`);
    expect(rows[0].last_failure_reason).toBe("connection refused");
    expect(rows[0].consecutive_failures).toBe(3);
  });

  // ── deduplication ────────────────────────────────────────────────────────────────────
  it("REFUSES a duplicate observation for the same company and identity key", async () => {
    const key = `${CO_A}:dupe:${randomUUID()}`;
    await db.query(
      `insert into management_items (company_id,department,kind,subject_table,subject_id,identity_key)
       values ($1,'finance','k','t','1',$2)`, [CO_A, key]);
    await expect(
      db.query(`insert into management_items (company_id,department,kind,subject_table,subject_id,identity_key)
                values ($1,'finance','k','t','1',$2)`, [CO_A, key]),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("ALLOWS the same identity key in a different company", async () => {
    const key = `shared:${randomUUID()}`;
    await db.query(`insert into management_items (company_id,department,kind,subject_table,subject_id,identity_key)
                    values ($1,'finance','k','t','1',$2)`, [CO_A, key]);
    await expect(
      db.query(`insert into management_items (company_id,department,kind,subject_table,subject_id,identity_key)
                values ($1,'finance','k','t','1',$2)`, [CO_B, key]),
    ).resolves.toBeTruthy();
  });
});

/** Rollback runs LAST, in its own describe, so it cannot destroy the schema mid-suite. */
describe.skipIf(!enabled)("R1 draft schema — rollback leaves nothing behind", () => {
  it("removes every R1 table and function", async () => {
    execFileSync("node", ["scripts/r1/draft-migrate.mjs", "--down"], {
      env: { ...process.env, R1_DRAFT_CONFIRM: "disposable-local-only" },
      stdio: "pipe",
    });
    const c = new pg.Client({ connectionString: URL, ssl: false });
    await c.connect();
    try {
      const { rows: tables } = await c.query(
        `select table_name from information_schema.tables where table_schema='public'
          and table_name in ('management_items','management_item_transitions','management_item_evidence',
                             'management_item_decisions','observation_sources','management_item_feedback')`,
      );
      expect(tables).toEqual([]);

      const { rows: fns } = await c.query(
        `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and proname like 'r1_draft_%'`,
      );
      expect(fns).toEqual([]);

      const { rows: ledger } = await c.query(`select count(*)::int as n from r1_draft_migrations`);
      expect(ledger[0].n).toBe(0);
    } finally {
      await c.end();
    }
  }, 60_000);
});
