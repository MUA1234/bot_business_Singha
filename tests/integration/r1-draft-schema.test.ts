/**
 * The Release 1 kernel schema — live PostgreSQL behavioural tests (checkpoint 2).
 *
 * Proves at the DATABASE boundary what `tests/kernel/lifecycle.test.ts` proves in pure code,
 * because an invariant enforced only in application code is a convention, not a control.
 *
 * ── This suite used to test a quarantined draft chain ────────────────────────────────────────
 *
 * It applied `src/db/draft-migrations-r1/` through a special runner, checked the units landed in
 * their own `r1_draft_migrations` ledger and NOT in `schema_migrations`, and rolled them back.
 * The chain was promoted to `0111`–`0140` on 2026-09-11, so every one of those premises is now
 * false: the ordinary runner applies them, there is one ledger, and the rollback SQL lives in
 * `src/db/rollback/`.
 *
 * The BEHAVIOURAL tests below are unchanged, because what they prove did not change — the
 * lifecycle map, illegal-transition refusal, two-connection concurrency, the zero-evidence
 * prohibition, cross-company rejection, append-only history and deadline provenance are
 * properties of the schema, not of how it got applied. What changed is the setup, the ledger
 * assertion and the rollback.
 *
 * Skipped unless DATABASE_URL points at a disposable local database.
 * Run: see scripts/r1/run-draft-schema-tests.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { URL as NodeURL } from "node:url";

const SHARED_URL = process.env.DATABASE_URL ?? "";
const enabled = !!SHARED_URL && /127\.0\.0\.1|localhost|\[::1\]/.test(SHARED_URL);

/**
 * THIS SUITE GETS ITS OWN DATABASE, and that is a correctness requirement, not tidiness.
 *
 * It applies the whole draft chain and then ROLLS IT BACK, on purpose — proving the rollback
 * leaves nothing behind is one of the things it exists to prove. Run against the shared
 * integration database, that teardown removed the schema every other kernel suite depends on,
 * and left residue when it did not complete: after two whole-directory runs the shared
 * `r1_draft_migrations` ledger held 8 rows and then 15, of 28. Which suites failed became a
 * function of file ordering, and the enumeration gates (`secure-definer-grants`,
 * `search-path-safety`) failed against draft objects they correctly refuse to classify.
 *
 * So it builds a scratch database, migrates it, uses it, and drops it. Nothing it does is
 * visible to any other suite.
 */
const SCRATCH_DB = `r1_draft_schema_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * Same server, different database.
 *
 * `URL` is shadowed below by this suite's own connection-string constant, so the WHATWG parser is
 * imported under a distinct name rather than relying on the global.
 */
function urlFor(database: string): string {
  const u = new NodeURL(SHARED_URL);
  u.pathname = `/${database}`;
  return u.toString();
}
/** The maintenance database, for CREATE/DROP DATABASE. */
const ADMIN_URL = enabled ? urlFor("postgres") : "";
const URL = enabled ? urlFor(SCRATCH_DB) : "";

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL, ssl: false });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

const CO_A = randomUUID();
const CO_B = randomUUID();
const ACTOR = randomUUID();

/**
 * A real membership per company, because `management_items.accountable_owner_id` carries a
 * COMPOSITE foreign key to `memberships (id, company_id)` — an owner must be a membership of the
 * same company, which is the cross-company protection unit 008 exists to add.
 *
 * The old comment here said "standalone has no memberships table, so any uuid satisfies the
 * shape". That stopped being true when this suite moved onto a database carrying the released
 * schema, which it must, because the draft chain needs `public.permissions` from unit 023 onward.
 */
const OWNER_OF = new Map<string, string>();

let db: pg.Client;
let db2: pg.Client;

/** Insert an item directly (bypassing the kernel) so transitions can be tested in isolation. */
async function newItem(company = CO_A, state = "observed", kind = "receivable_overdue") {
  const id = randomUUID();
  // Working states require an accountable owner (unit 008), and that owner must be a REAL
  // membership of the same company — the composite FK refuses anything else, which is the
  // cross-company protection the unit exists to add. The AUTHORISATION of that owner (what the
  // holder may do) is proven separately in tests/integration/r1-security-baseline.test.ts.
  const owner = OWNER_OF.get(company) ?? randomUUID();
  const needsOwner = ["assigned", "monitoring", "escalated", "verifying", "verified"].includes(state);
  const needsRouting = state === "needs_routing";
  await db.query(
    `insert into management_items (id, company_id, department, kind, subject_table, subject_id,
                                   identity_key, state, accountable_owner_id,
                                   routing_department, routing_reason)
     values ($1,$2,'finance',$3,'customer_invoices',$4,$5,$6,$7,$8,$9)`,
    [id, company, kind, `inv-${id.slice(0, 8)}`, `${company}:${kind}:${id}`, state,
     needsOwner ? owner : null,
     needsRouting ? "finance" : null,
     needsRouting ? "seeded unrouted" : null],
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
    // Build the scratch database from nothing: shim, the released migrations the draft units
    // reference, then the draft chain itself.
    await withAdmin(async (c) => {
      await c.query(`drop database if exists "${SCRATCH_DB}"`);
      await c.query(`create database "${SCRATCH_DB}"`);
    });
    const env = { ...process.env, DATABASE_URL: URL, PGSSL: "disable", R1_DRAFT_CONFIRM: "disposable-local-only" };
    execFileSync("node", ["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"], { env, stdio: "pipe" });
    execFileSync("node", ["scripts/migrate.mjs"], { env, stdio: "pipe" });

    db = new pg.Client({ connectionString: URL, ssl: false });
    db2 = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db2.connect();
    // Companies and one membership each must exist BEFORE the draft chain: unit 008 adds the
    // composite owner FK, and unit 016 revalidates owners against it.
    for (const co of [CO_A, CO_B]) {
      await db.query(
        `insert into companies (id, name, base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `r1-draft ${co.slice(0, 8)}`],
      );
      const userId = randomUUID();
      await db.query(
        `insert into users (id, full_name, is_active) values ($1,$2,true) on conflict (id) do nothing`,
        [userId, `r1-draft owner ${co.slice(0, 8)}`],
      );
      const { rows } = await db.query(
        `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
           on conflict (company_id, user_id) do update set status = excluded.status returning id`,
        [co, userId],
      );
      const membershipId = String(rows[0].id);
      // Unit 008 requires the owner to be an ACTIVE, AUTHORISED membership: r1_draft_membership_can_own
      // demands `operations.task.work` or `operations.task.manage`. Being a member is not enough,
      // which is the point of the rule - a person nobody authorised cannot be made accountable.
      await db.query(
        `insert into membership_roles (membership_id, company_id, role_key)
           values ($1,$2,'project_manager') on conflict do nothing`,
        [membershipId, co],
      );
      OWNER_OF.set(co, membershipId);
    }

    // The ORDINARY runner. No draft runner, no R1_DRAFT_CONFIRM, no second ledger — that this
    // works at all is half of what the promotion had to establish.
    execFileSync("node", ["scripts/migrate.mjs"], { env, stdio: "pipe" });
  }, 300_000);

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

  it("records every migration in the ONE ledger, and there is no second one", async () => {
    // The inverse of what this test used to assert. The units are no longer quarantined, so the
    // correct outcome is that they are in `schema_migrations` with everything else — and that the
    // separate ledger does not exist at all, since a leftover one would mean a leftover runner.
    const onDisk = readdirSync("src/db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
    const { rows } = await db.query(`select count(*)::int as n from schema_migrations`);
    expect(rows[0].n, "the ledger does not match the migrations on disk").toBe(onDisk);

    const { rows: draftLedger } = await db.query(
      `select to_regclass('public.r1_draft_migrations') is not null as exists`);
    expect(draftLedger[0].exists, "the quarantine ledger still exists").toBe(false);

    // Contiguous, and reaching the kernel's own range.
    const { rows: range } = await db.query(
      `select min(version) lo, max(version) hi from schema_migrations`);
    expect(range[0].lo).toBe("0001");
    expect(Number(range[0].hi)).toBeGreaterThanOrEqual(140);
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
      // Assignment requires an accountable owner to have been CHOSEN first (unit 008) — the
      // loop cannot hand work to nobody. The owner must be a REAL membership of the same
      // company: unit 008's composite FK to `memberships (id, company_id)` refuses anything
      // else, which is the cross-company protection it exists to add. A random uuid used to
      // pass only because this suite ran on a database with no `memberships` table at all.
      // The AUTHORISATION of that owner — what the holder may then do — is proven separately in
      // tests/integration/r1-security-baseline.test.ts.
      if (to === "assigned") {
        await db.query(
          "update management_items set accountable_owner_id=$2 where id=$1",
          [id, OWNER_OF.get(CO_A)!],
        );
      }
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
    // The transition itself must carry the reason (unit 008): R1-D-3 forbids unrouted work
    // sitting silently, so a follow-up UPDATE cannot be the place it is recorded.
    await expect(transition(db, id, "recommended", "needs_routing", null))
      .rejects.toThrow(/requires a reason/i);

    const r = await transition(db, id, "recommended", "needs_routing",
      "no available finance officer with the required capability");
    expect(r.rows[0].r.result).toBe("transitioned");

    const { rows } = await db.query(
      `select routing_reason, routing_department, routing_requested_at, accountable_owner_id
         from management_items where id=$1`, [id]);
    expect(rows[0].routing_reason).toMatch(/no available finance officer/);
    expect(rows[0].routing_department).toBe("finance");   // defaulted from the item department
    expect(rows[0].routing_requested_at).not.toBeNull();
    expect(rows[0].accountable_owner_id).toBeNull();       // released, not left stale
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
describe.skipIf(!enabled)("the kernel rollback scripts leave the released schema standing", () => {
  it("applied in REVERSE order, they remove the kernel and nothing else", async () => {
    // `src/db/rollback/` replaced the draft chain's `.down.sql` files. The forward runner never
    // reads it, so applying one is a deliberate manual act — which is what this does, in reverse
    // dependency order, exactly as an operator rolling back would have to.
    //
    // The assertion has TWO halves, and the second is the one that matters. "The kernel is gone"
    // was all the old test checked, against a database that had never held anything else. Here
    // the rollback runs on a database carrying the full released chain, so it can also be asked
    // the question that makes it a rollback rather than a wipe: is everything else still there?
    const c = new pg.Client({ connectionString: URL, ssl: false });
    await c.connect();
    try {
      const releasedBefore = Number((await c.query(
        `select count(*)::int n from information_schema.tables
          where table_schema='public' and table_name in
          ('companies','users','memberships','tasks','projects','customers','quotations',
           'journal_entries','message_outbox','audit_events')`)).rows[0].n);
      expect(releasedBefore, "the released tables were not there to begin with").toBe(10);

      const files = readdirSync("src/db/rollback")
        .filter((f) => /^\d{4}_.*\.down\.sql$/.test(f))
        .sort()
        .reverse();
      expect(files.length, "no rollback scripts found").toBeGreaterThanOrEqual(30);

      for (const f of files) {
        const sql = readFileSync(`src/db/rollback/${f}`, "utf8");
        try {
          await c.query(sql);
        } catch (e) {
          throw new Error(`rollback ${f} failed: ${(e as Error).message}`);
        }
      }

      // Half one: the kernel is gone.
      const { rows: tables } = await c.query(
        `select table_name from information_schema.tables where table_schema='public'
          and table_name in ('management_items','management_item_transitions','management_item_evidence',
                             'management_item_decisions','observation_sources','management_item_feedback',
                             'management_cycle_leases')`);
      expect(tables.map((r) => r.table_name), "kernel tables survived the rollback").toEqual([]);

      const { rows: fns } = await c.query(
        `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and (proname like 'r1_exec_%' or proname like 'r1_draft_%')`);
      expect(fns.map((r) => r.proname), "kernel functions survived the rollback").toEqual([]);

      // Half two: everything the released chain built is untouched.
      const releasedAfter = Number((await c.query(
        `select count(*)::int n from information_schema.tables
          where table_schema='public' and table_name in
          ('companies','users','memberships','tasks','projects','customers','quotations',
           'journal_entries','message_outbox','audit_events')`)).rows[0].n);
      expect(releasedAfter, "the rollback removed released tables too").toBe(releasedBefore);
    } finally {
      await c.end();
    }
  }, 120_000);

  /**
   * Drop the scratch database. Runs after the rollback check, and tolerates failure: a leaked
   * database on a disposable container is untidy, whereas failing the suite here would report a
   * cleanup problem as a product problem.
   */
  afterAll(async () => {
    if (!enabled) return;
    await withAdmin(async (c) => {
      await c.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [SCRATCH_DB],
      );
      await c.query(`drop database if exists "${SCRATCH_DB}"`);
    }).catch(() => {});
  }, 60_000);
});
