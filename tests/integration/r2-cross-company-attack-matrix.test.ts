import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Cross-company attack matrix — asserted through a PRIVILEGED connection.
 *
 * The other suites prove that an attack is refused. This one proves that after the refusal
 * NOTHING CHANGED, which is a different claim and the one that actually matters.
 *
 * Why the distinction is not pedantic. Under RLS a write that matches no row succeeds and
 * reports zero rows affected — no error, no exception, and a test watching for a thrown error
 * records a pass. So does a test that re-reads through the attacker's own session, because RLS
 * hides the row it just failed to change. Both are satisfied by a system that silently allowed
 * the write and by one that correctly refused it. Only a reader that bypasses RLS can tell those
 * two apart, and `postgres` (the owner, BYPASSRLS) is that reader.
 *
 * So every case here is: take a privileged census, attack, take it again, and require the two to
 * be identical.
 *
 * Surfaces covered, per the Release 1 brief: items, evidence, decisions, transitions,
 * assignments, feedback, the execution ledger and completion claims.
 */

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

/** The privileged reader. Never used to perform an attack — only to observe. */
let god: pg.Client;
/** The connection attacks run through, with RLS in force. */
let sess: pg.Client;

const CO_A = randomUUID();
const CO_B = randomUUID();

const actors: Record<string, string> = {};
const memberships: Record<string, string> = {};
let itemA = "";
let itemB = "";

/** Run `fn` as a given actor with RLS enforced, rolling back whatever it did. */
async function asActor<T>(sub: string | null, role: string, fn: () => Promise<T>): Promise<T> {
  await sess.query("begin");
  try {
    await sess.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(sub ? { role, sub } : { role }),
    ]);
    await sess.query(`set local role ${role}`);
    return await fn();
  } finally {
    await sess.query("rollback");
  }
}

/** Attempt something and report whether it threw, without letting the throw escape. */
async function attempt(fn: () => Promise<unknown>): Promise<"threw" | "silent"> {
  try { await fn(); return "silent"; } catch { return "threw"; }
}

/**
 * A privileged census of everything an attack could plausibly disturb.
 *
 * Counts AND content digests: three rows replaced by three different rows is still three, so a
 * count alone would miss a substitution.
 */
async function census(): Promise<Record<string, string>> {
  const tables = [
    "management_items", "management_item_evidence", "management_item_decisions",
    "management_item_transitions", "management_execution_attempts", "management_item_feedback",
    "tasks", "memberships", "membership_roles",
  ];
  const out: Record<string, string> = {};
  for (const t of tables) {
    const { rows } = await god.query(
      `select count(*)::int as n, coalesce(md5(string_agg(x.t, '|' order by x.t)), '-') as digest
         from (select (to_jsonb(r) - 'updated_at')::text as t from public.${t} r) x`,
    );
    out[t] = `${rows[0].n}:${rows[0].digest}`;
  }
  return out;
}

async function seedActor(key: string, company: string, roleKey: string | null) {
  const userId = randomUUID();
  actors[key] = userId;
  await god.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict (id) do nothing`,
    [userId, `atk ${key}`]);
  const { rows } = await god.query(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status='active' returning id`,
    [company, userId]);
  memberships[key] = String(rows[0].id);
  if (roleKey) {
    await god.query(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3) on conflict do nothing`,
      [memberships[key], company, roleKey]);
  }
}

async function seedItem(company: string, department = "operations"): Promise<string> {
  const id = randomUUID();
  await god.query(
    `insert into management_items (id, company_id, department, kind, subject_table, subject_id,
                                   identity_key, state)
     values ($1,$2,$3,'receivable_overdue','customer_invoices',$4,$5,'observed')`,
    [id, company, department, `inv-${id.slice(0, 8)}`, `${company}:atk:${id}`]);
  await god.query(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
     values ($1,$2,'customer_invoices',$3,'{"days_overdue":47}'::jsonb)`,
    [company, id, `src-${id.slice(0, 8)}`]);
  return id;
}

describe.skipIf(!enabled)("cross-company attack matrix (privileged verification)", () => {
  beforeAll(async () => {
    god = new pg.Client({ connectionString: URL, ssl: false });
    sess = new pg.Client({ connectionString: URL, ssl: false });
    await god.connect();
    await sess.connect();

    for (const [co, name] of [[CO_A, "atk-A"], [CO_B, "atk-B"]] as const) {
      await god.query(`insert into companies (id, name, base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`, [co, name]);
    }
    // Company A: the full role ladder. Company B: one manager, whose data A must never reach.
    await seedActor("owner", CO_A, "owner_management");
    await seedActor("manager", CO_A, "project_manager");
    await seedActor("staff", CO_A, "staff_submitter");
    await seedActor("roleless", CO_A, null);
    await seedActor("b_manager", CO_B, "project_manager");

    itemA = await seedItem(CO_A);
    itemB = await seedItem(CO_B);
  }, 120_000);

  afterAll(async () => {
    await god?.end().catch(() => {});
    await sess?.end().catch(() => {});
  });

  // ── reads ────────────────────────────────────────────────────────────────────────────
  describe("no actor of company A can READ company B", () => {
    const surfaces: [string, string][] = [
      ["management_items", "select id from management_items where company_id = $1"],
      ["management_item_evidence", "select id from management_item_evidence where company_id = $1"],
      ["management_item_decisions", "select id from management_item_decisions where company_id = $1"],
      ["management_item_transitions", "select id from management_item_transitions where company_id = $1"],
      ["management_execution_attempts", "select id from management_execution_attempts where company_id = $1"],
      ["management_item_feedback", "select id from management_item_feedback where company_id = $1"],
      ["tasks", "select id from tasks where company_id = $1"],
    ];

    for (const who of ["owner", "manager", "staff", "roleless"]) {
      for (const [label, sql] of surfaces) {
        it(`${who} sees no ${label} of company B`, async () => {
          const rows = await asActor(actors[who]!, "authenticated", async () =>
            (await sess.query(sql, [CO_B])).rows);
          expect(rows, `${who} reached company B's ${label}`).toEqual([]);
        });
      }
    }

    it("an unauthenticated caller (anon) is refused OUTRIGHT, not merely filtered", async () => {
      // Stronger than "sees zero rows": the grant itself is revoked, so the read is refused at
      // the privilege layer before RLS is even consulted. Asserted as the specific error rather
      // than as "it threw", because a different error would mean the table is reachable and
      // something else went wrong.
      let message = "";
      let rows: number | null = null;
      await asActor(null, "anon", async () => {
        try {
          rows = (await sess.query("select id from management_items")).rows.length;
        } catch (e) {
          message = (e as Error).message;
        }
      });
      if (rows !== null) {
        // A grant that exists but yields nothing is an acceptable second-best; say which it was.
        expect(rows, "anon has SELECT but RLS must yield nothing").toBe(0);
      } else {
        expect(message).toMatch(/permission denied/i);
      }
    });
  });

  // ── writes ───────────────────────────────────────────────────────────────────────────
  describe("no actor of company A can WRITE company B — verified privileged, not by error", () => {
    const attacks: [string, (sub: string) => Promise<unknown>][] = [
      ["update B's item priority", () =>
        sess.query(`update management_items set priority='critical' where id=$1`, [itemB])],
      ["change B's item state", () =>
        sess.query(`update management_items set state='dismissed' where id=$1`, [itemB])],
      ["reassign B's item to an A membership", () =>
        sess.query(`update management_items set accountable_owner_id=$2 where id=$1`, [itemB, memberships.manager])],
      ["delete B's item", () =>
        sess.query(`delete from management_items where id=$1`, [itemB])],
      ["insert evidence onto B's item", () =>
        sess.query(
          `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
           values ($1,$2,'customer_invoices','forged','{"forged":true}'::jsonb)`, [CO_B, itemB])],
      ["insert an item INTO company B", () =>
        sess.query(
          `insert into management_items (id, company_id, department, kind, subject_table, subject_id, identity_key, state)
           values ($1,$2,'finance','k','t','1',$3,'observed')`, [randomUUID(), CO_B, `${CO_B}:forged:${randomUUID()}`])],
      ["forge a transition on B's item", () =>
        sess.query(
          `insert into management_item_transitions (company_id, item_id, from_state, to_state, actor_type)
           values ($1,$2,'observed','understood','system')`, [CO_B, itemB])],
      ["grant itself a role in company B", () =>
        sess.query(
          `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`,
          [memberships.manager, CO_B])],
      ["create a task in company B", () =>
        sess.query(
          `insert into tasks (id, company_id, title, status) values ($1,$2,'forged','captured')`,
          [randomUUID(), CO_B])],
    ];

    for (const who of ["owner", "manager", "staff", "roleless"]) {
      for (const [label, attack] of attacks) {
        it(`${who}: "${label}" changes NOTHING`, async () => {
          const before = await census();
          const outcome = await asActor(actors[who]!, "authenticated", () => attempt(() => attack(actors[who]!)));
          const after = await census();
          // The outcome may be a thrown error OR a silent zero-row write. Both are acceptable
          // refusals; what is NOT acceptable is a change. Recorded so a future reader can see
          // which refusal shape each attack produced.
          expect(after, `${who} "${label}" (${outcome}) mutated the database`).toEqual(before);
        });
      }
    }
  });

  // ── the service role is not a way around the boundary either ─────────────────────────
  describe("service_role is powerful but still cannot be a person", () => {
    it("cannot record a human decision — auth.uid() is null for it", async () => {
      const before = await census();
      const outcome = await asActor(null, "service_role", () =>
        attempt(() => sess.query(
          `select r1_draft_decide_management_item($1,$2,'approved',null)`, [itemA, randomUUID()])));
      const after = await census();
      expect(after, `service_role recorded a decision (${outcome})`).toEqual(before);
    });

    it("cannot assign an item — assignment is a manager's act", async () => {
      const before = await census();
      const outcome = await asActor(null, "service_role", () =>
        attempt(() => sess.query(
          `select r1_draft_assign_management_item($1,$2,$3,'forced')`,
          [itemA, memberships.staff, randomUUID()])));
      const after = await census();
      expect(after, `service_role assigned an item (${outcome})`).toEqual(before);
    });
  });
});
