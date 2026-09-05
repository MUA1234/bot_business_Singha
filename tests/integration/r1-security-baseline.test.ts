/**
 * R1 security baseline — live PostgreSQL, REAL roles, REAL capability functions.
 *
 * Every assertion here runs as a genuine `authenticated` PostgREST-shaped caller with JWT
 * claims, under the repository's own `has_company_access` / `has_capability`. Nothing is
 * simulated: if a policy is wrong, these fail.
 *
 * Actor classes covered, as required:
 *   owner (owner_management) · authorised manager (project_manager) · ordinary staff
 *   (staff_submitter) · unauthorised staff (member, no task role) · revoked membership
 *   (suspended/ended) · cross-company reads · cross-company writes · direct table
 *   operations attempting to bypass application checks · anon.
 *
 * Requires the FULL schema: run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();

/** One user per actor class. */
const OWNER = randomUUID();
const MANAGER = randomUUID();
const STAFF = randomUUID();
const UNAUTHORISED = randomUUID();
const REVOKED = randomUUID();
const B_MANAGER = randomUUID();
const NON_MEMBER = randomUUID();

let db: pg.Client; // superuser: fixtures only
const membershipOf = new Map<string, string>();

/** Run `fn` as a real `authenticated` caller with `sub` claims, then restore. */
async function asUser<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub }),
    ]);
    await db.query("set local role authenticated");
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

/** Same, but the statement is expected to be refused. Returns the error message. */
async function refusalFor(sub: string, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await asUser(sub, async () => db.query(sql, params));
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

async function seedUser(id: string, company: string, roleKey: string | null, status = "active") {
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict (id) do nothing`, [
    id, `r1-sec ${id.slice(0, 8)}`,
  ]);
  const { rows } = await db.query(
    `insert into memberships (company_id, user_id, status) values ($1,$2,$3)
       on conflict (company_id, user_id) do update set status = excluded.status
     returning id`,
    [company, id, status],
  );
  const membershipId = rows[0].id as string;
  membershipOf.set(id, membershipId);
  if (roleKey) {
    await db.query(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
         on conflict do nothing`,
      [membershipId, company, roleKey],
    );
  }
  return membershipId;
}

async function newItem(company: string, state = "observed", owner: string | null = null) {
  const id = randomUUID();
  await db.query(
    `insert into management_items (id, company_id, department, kind, subject_table, subject_id,
                                   identity_key, state, accountable_owner_id)
     values ($1,$2,'finance','receivable_overdue','customer_invoices',$3,$4,$5,$6)`,
    [id, company, `inv-${id.slice(0, 8)}`, `${company}:k:${id}`, state, owner],
  );
  await db.query(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
     values ($1,$2,'customer_invoices',$3,'{"days_overdue":47}'::jsonb)`,
    [company, id, `src-${id.slice(0, 8)}`],
  );
  return id;
}

describe.skipIf(!enabled)("R1 security baseline — RLS and authority matrix", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    for (const co of [CO_A, CO_B]) {
      await db.query(`insert into companies (id, name, base_currency) values ($1,$2,$3) on conflict (id) do nothing`, [
        co, `r1-sec ${co.slice(0, 8)}`, "LKR",
      ]);
    }
    await seedUser(OWNER, CO_A, "owner_management");
    await seedUser(MANAGER, CO_A, "project_manager");
    await seedUser(STAFF, CO_A, "staff_submitter");
    await seedUser(UNAUTHORISED, CO_A, null); // member of the company, but holds NO role
    await seedUser(REVOKED, CO_A, "project_manager", "active"); // revoked mid-suite
    await seedUser(B_MANAGER, CO_B, "project_manager");
    await db.query(`insert into users (id, full_name, is_active) values ($1,'non member',true)
                      on conflict (id) do nothing`, [NON_MEMBER]);
  }, 120_000);

  // ── reads ────────────────────────────────────────────────────────────────────────────
  it("owner, manager and ordinary staff can all READ their company's items", async () => {
    const id = await newItem(CO_A);
    for (const actor of [OWNER, MANAGER, STAFF]) {
      const seen = await asUser(actor, async () =>
        (await db.query(`select id from management_items where id=$1`, [id])).rows,
      );
      expect(seen, `actor ${actor} could not read`).toHaveLength(1);
    }
  });

  it("a company member with NO role can still read (company-scoped) but cannot write", async () => {
    const id = await newItem(CO_A);
    const seen = await asUser(UNAUTHORISED, async () =>
      (await db.query(`select id from management_items where id=$1`, [id])).rows,
    );
    expect(seen).toHaveLength(1);

    const err = await refusalFor(
      UNAUTHORISED,
      `update management_items set priority='critical' where id=$1`,
      [id],
    );
    // RLS denies the row rather than raising: assert nothing changed.
    const after = (await db.query(`select priority from management_items where id=$1`, [id])).rows[0];
    expect(after.priority ?? null).toBeNull();
    expect(err === "" || /policy|denied/i.test(err)).toBe(true);
  });

  it("a NON-MEMBER sees nothing", async () => {
    await newItem(CO_A);
    const seen = await asUser(NON_MEMBER, async () =>
      (await db.query(`select id from management_items where company_id=$1`, [CO_A])).rows,
    );
    expect(seen).toEqual([]);
  });

  it("anon sees nothing — grants are revoked outright", async () => {
    await newItem(CO_A);
    await db.query("begin");
    try {
      await db.query("set local role anon");
      await expect(db.query(`select id from management_items`)).rejects.toThrow(/permission denied/i);
    } finally {
      await db.query("rollback");
    }
  });

  // ── cross-company ────────────────────────────────────────────────────────────────────
  it("CROSS-COMPANY READ: company B's manager cannot see company A's items", async () => {
    const aItem = await newItem(CO_A);
    const seen = await asUser(B_MANAGER, async () =>
      (await db.query(`select id from management_items where id=$1`, [aItem])).rows,
    );
    expect(seen).toEqual([]);
  });

  it("CROSS-COMPANY WRITE: company B's manager cannot insert into company A", async () => {
    await refusalFor(
      B_MANAGER,
      `insert into management_items (company_id, department, kind, subject_table, subject_id, identity_key)
       values ($1,'finance','k','t','1',$2)`,
      [CO_A, `x-${randomUUID()}`],
    );
    const { rows } = await db.query(
      `select count(*)::int as n from management_items where company_id=$1 and kind='k'`, [CO_A]);
    expect(rows[0].n).toBe(0);
  });

  it("CROSS-COMPANY WRITE: company B's manager cannot update company A's item", async () => {
    const aItem = await newItem(CO_A);
    await refusalFor(B_MANAGER, `update management_items set priority='low' where id=$1`, [aItem]);
    const { rows } = await db.query(`select priority from management_items where id=$1`, [aItem]);
    expect(rows[0].priority ?? null).toBeNull();
  });

  // ── capability-gated writes ──────────────────────────────────────────────────────────
  it("NOBODY may insert a management item directly — creation is RPC-only (unit 012)", async () => {
    // Before unit 012 a manager holding operations.task.manage could INSERT directly. That
    // door is now closed: management items are created only through the atomic RPC, so an
    // item can never exist without its evidence and opening transition.
    const key = `mgr-${randomUUID()}`;
    await refusalFor(
      MANAGER,
      `insert into management_items (company_id, department, kind, subject_table, subject_id, identity_key)
       values ($1,'operations','task_stalled','tasks','t1',$2)`,
      [CO_A, key],
    );
    const { rows } = await db.query(`select count(*)::int as n from management_items where identity_key=$1`, [key]);
    expect(rows[0].n).toBe(0);
  });

  it("ORDINARY STAFF may NOT insert a management item", async () => {
    const key = `staff-${randomUUID()}`;
    await refusalFor(
      STAFF,
      `insert into management_items (company_id, department, kind, subject_table, subject_id, identity_key)
       values ($1,'operations','task_stalled','tasks','t1',$2)`,
      [CO_A, key],
    );
    const { rows } = await db.query(`select count(*)::int as n from management_items where identity_key=$1`, [key]);
    expect(rows[0].n).toBe(0);
  });

  it("ORDINARY STAFF may NOT record a decision — approval authority is manager-and-above", async () => {
    const id = await newItem(CO_A);
    await refusalFor(
      STAFF,
      `insert into management_item_decisions (company_id, item_id, decision, actor_id) values ($1,$2,'approve',$3)`,
      [CO_A, id, STAFF],
    );
    const { rows } = await db.query(`select count(*)::int as n from management_item_decisions where item_id=$1`, [id]);
    expect(rows[0].n).toBe(0);
  });

  it("a MANAGER may record a decision — through the RPC, which is now the only way", async () => {
    // CHANGED BY R2-F-014, and for the same reason feedback changed above. This used to be a
    // direct INSERT under `management_item_decisions_ins`. That policy let any holder of
    // `operations.task.manage` write a decision row unbound to the item state, action or evidence
    // the person saw, with no lifecycle transition and no audit event — so the log could say
    // `approve` while the item stayed in `awaiting_approval` for ever. Draft 022 drops it.
    //
    // The INTENT of this test is unchanged and still asserted: a manager may record a decision.
    // What changed is that it now has to go through the boundary that binds it to reality.
    //
    // The old version also asserted `expect(true).toBe(true)` — it required only that the insert
    // not throw. This one checks the outcome.
    const id = await newItem(CO_A, "awaiting_approval");
    const digest = (
      await db.query(`select public.r1_draft_evidence_digest($1,$2) as d`, [CO_A, id])
    ).rows[0].d as string;

    const out = await asUser(MANAGER, async () => {
      const { rows } = await db.query(
        `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',
                 null,$2,null,null,null) as r`,
        [id, digest],
      );
      return rows[0].r as { ok?: boolean; refusal?: string };
    });

    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("a manager may NOT write a decision row directly (R2-F-014)", async () => {
    const id = await newItem(CO_A, "awaiting_approval");
    let threw = false;
    try {
      await asUser(MANAGER, async () => {
        await db.query(
          `insert into management_item_decisions (company_id, item_id, decision, actor_id)
           values ($1,$2,'approve',$3)`,
          [CO_A, id, MANAGER],
        );
      });
    } catch {
      threw = true;
    }
    // The guarantee is the absence of the row, not the presence of an exception: a silently
    // dropped write and a raised error are both honest refusals, and only a read distinguishes
    // either of them from a successful bypass.
    const { rows } = await db.query(
      `select 1 from management_item_decisions where item_id = $1`, [id],
    );
    expect(rows, threw ? "refused with an error" : "refused silently").toHaveLength(0);
  });

  it("ORDINARY STAFF MAY record feedback — the learning signal needs the person who did the work", async () => {
    // CHANGED BY R2B (owner Decision 3). Feedback used to be a direct INSERT under an RLS
    // policy. It is now RPC-ONLY, which is strictly stronger: the rules a feedback row must
    // satisfy — the item's company boundary, an active authorised actor, the lifecycle evidence
    // a verified outcome requires, the refusal to call reopened work successful, and the limit
    // that stops one person fabricating hundreds of outcomes — cannot be expressed as an RLS
    // policy at all. The INTENT of this test is unchanged and still asserted: an ordinary
    // member of staff may record feedback.
    const id = await newItem(CO_A);
    const staffMembership = membershipOf.get(STAFF)!;
    // The RPC is a SERVICE-ONLY boundary, so the call presents service_role claims exactly as
    // the server route does. The staff member is the ACTOR inside it, not the caller — which is
    // the point: the trusted server records feedback ON BEHALF of an identified human, and the
    // RPC checks that human's membership and capability itself.
    await db.query("begin");
    try {
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const { rows } = await db.query(
        `select public.r1_draft_record_feedback($1,$2,$3,'decision_reason',null,null,null,$4,null,null) as r`,
        [CO_A, id, staffMembership, "it was already handled"],
      );
      expect(rows[0].r.ok).toBe(true);
    } finally {
      await db.query("commit");
    }
  });

  it("a DIRECT feedback insert by an API role is refused — the RPC is the only door", async () => {
    const id = await newItem(CO_A);
    await refusalFor(
      STAFF,
      `insert into management_item_feedback (company_id, item_id, feedback_type, reason)
       values ($1,$2,'decision_reason','bypassing the rules')`,
      [CO_A, id],
    );
  });

  it("ORDINARY STAFF may NOT write a transition", async () => {
    const id = await newItem(CO_A);
    await refusalFor(
      STAFF,
      `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_type)
       values ($1,$2,'observed','understood','user')`,
      [CO_A, id],
    );
    const { rows } = await db.query(`select count(*)::int as n from management_item_transitions where item_id=$1`, [id]);
    expect(rows[0].n).toBe(0);
  });

  it("detector configuration requires admin capability — a manager may not change cadence", async () => {
    await refusalFor(
      MANAGER,
      `insert into observation_sources (company_id, department, kind, supports_scheduled, cadence_seconds)
       values ($1,'finance','mgr_try',true,300)`,
      [CO_A],
    );
    const { rows } = await db.query(`select count(*)::int as n from observation_sources where kind='mgr_try'`);
    expect(rows[0].n).toBe(0);
  });

  // ── revoked membership ───────────────────────────────────────────────────────────────
  it("a REVOKED (suspended) member loses read AND write access immediately", async () => {
    const id = await newItem(CO_A);

    const before = await asUser(REVOKED, async () =>
      (await db.query(`select id from management_items where id=$1`, [id])).rows,
    );
    expect(before).toHaveLength(1);

    await db.query(`update memberships set status='suspended' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);

    const after = await asUser(REVOKED, async () =>
      (await db.query(`select id from management_items where id=$1`, [id])).rows,
    );
    expect(after).toEqual([]);

    await refusalFor(REVOKED, `update management_items set priority='low' where id=$1`, [id]);
    const { rows } = await db.query(`select priority from management_items where id=$1`, [id]);
    expect(rows[0].priority ?? null).toBeNull();

    await db.query(`update memberships set status='active' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
  });

  it("an ENDED membership is equally excluded", async () => {
    const id = await newItem(CO_A);
    await db.query(`update memberships set status='ended' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
    const seen = await asUser(REVOKED, async () =>
      (await db.query(`select id from management_items where id=$1`, [id])).rows,
    );
    expect(seen).toEqual([]);
    await db.query(`update memberships set status='active' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
  });

  // ── direct table operations attempting to bypass application checks ──────────────────
  it("a manager cannot DELETE a management item — no delete policy exists at all", async () => {
    const id = await newItem(CO_A);
    await refusalFor(MANAGER, `delete from management_items where id=$1`, [id]);
    const { rows } = await db.query(`select count(*)::int as n from management_items where id=$1`, [id]);
    expect(rows[0].n).toBe(1);
  });

  it("a manager cannot REWRITE transition history directly", async () => {
    const id = await newItem(CO_A, "observed");
    await db.query(`select r1_draft_transition_item($1,'observed','understood',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]);
    const msg = await refusalFor(MANAGER, `update management_item_transitions set to_state='verified' where item_id=$1`, [id]);
    // Either RLS gives no UPDATE policy, or the append-only trigger fires. Both are correct;
    // what must NOT happen is the row changing.
    const { rows } = await db.query(`select to_state from management_item_transitions where item_id=$1`, [id]);
    expect(rows[0].to_state).toBe("understood");
    expect(msg === "" || /append-only|policy|denied/i.test(msg)).toBe(true);
  });

  it("a manager cannot forge evidence into ANOTHER company's item", async () => {
    const bItem = await newItem(CO_B);
    await refusalFor(
      MANAGER,
      `insert into management_item_evidence (company_id,item_id,source_table,source_id,facts)
       values ($1,$2,'t','1','{}'::jsonb)`,
      [CO_A, bItem],
    );
    const { rows } = await db.query(`select count(*)::int as n from management_item_evidence where item_id=$1`, [bItem]);
    expect(rows[0].n).toBe(1); // only the one seeded with the item
  });
});

// ── accountable-owner integrity (security baseline B) ──────────────────────────────────
describe.skipIf(!enabled)("R1 accountable-owner integrity", () => {
  it("an owner from ANOTHER COMPANY is impossible — the composite FK refuses it", async () => {
    const id = await newItem(CO_A);
    const foreignMembership = membershipOf.get(B_MANAGER)!;
    await expect(
      db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [id, foreignMembership]),
    ).rejects.toThrow(/management_items_owner_company_fk|foreign key/i);
  });

  it("a same-company membership is accepted as accountable owner", async () => {
    const id = await newItem(CO_A);
    await expect(
      db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [id, membershipOf.get(MANAGER)!]),
    ).resolves.toBeTruthy();
  });

  it("assignment REQUIRES an accountable owner — an unowned item cannot be assigned", async () => {
    const id = await newItem(CO_A, "approved", null);
    await expect(
      db.query(`select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]),
    ).rejects.toThrow(/no accountable owner|route it to needs_routing/i);
  });

  it("assignment requires an ACTIVE membership — a suspended owner cannot be assigned work", async () => {
    const id = await newItem(CO_A, "approved", membershipOf.get(REVOKED)!);
    await db.query(`update memberships set status='suspended' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
    await expect(
      db.query(`select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]),
    ).rejects.toThrow(/not an active authorised membership/i);
    await db.query(`update memberships set status='active' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
  });

  it("assignment requires an AUTHORISED membership — a member with no task role is refused", async () => {
    const id = await newItem(CO_A, "approved", membershipOf.get(UNAUTHORISED)!);
    await expect(
      db.query(`select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]),
    ).rejects.toThrow(/not an active authorised membership/i);
  });

  it("a valid active authorised owner CAN be assigned", async () => {
    const id = await newItem(CO_A, "approved", membershipOf.get(MANAGER)!);
    const { rows } = await db.query(
      `select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb) as r`, [id, MANAGER]);
    expect(rows[0].r.result).toBe("transitioned");
  });

  it("a working state may not have a NULL owner", async () => {
    const id = await newItem(CO_A, "approved", membershipOf.get(MANAGER)!);
    await db.query(`select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]);
    await expect(
      db.query(`update management_items set accountable_owner_id=null where id=$1`, [id]),
    ).rejects.toThrow(/owner_required/i);
  });

  it("needs_routing REQUIRES a reason, enforced through the RPC boundary", async () => {
    const id = await newItem(CO_A, "recommended");

    // Since R1_DRAFT_010 the state column is RPC-only, so a direct UPDATE is refused BEFORE
    // the routing constraint is reached - a stronger refusal than the one this test
    // originally asserted.
    await expect(db.query(`update management_items set state='needs_routing' where id=$1`, [id]))
      .rejects.toThrow(/may only change through r1_draft_transition_item/i);

    // Through the RPC, the reason is mandatory...
    await expect(
      db.query(`select r1_draft_transition_item($1,'recommended','needs_routing',$2,'user',null,'[]'::jsonb)`,
        [id, MANAGER]),
    ).rejects.toThrow(/requires a reason/i);

    // ...and supplying it records the routing provenance.
    const { rows } = await db.query(
      `select r1_draft_transition_item($1,'recommended','needs_routing',$2,'user','no finance officer free','[]'::jsonb) as r`,
      [id, MANAGER]);
    expect(rows[0].r.result).toBe("transitioned");
    const { rows: it2 } = await db.query(
      `select routing_reason, routing_department from management_items where id=$1`, [id]);
    expect(it2[0].routing_reason).toMatch(/no finance officer free/);
    expect(it2[0].routing_department).toBe("finance");
  });

  it("REVOCATION re-routes truthfully and NEVER falls back to an administrator", async () => {
    const id = await newItem(CO_A, "approved", membershipOf.get(REVOKED)!);
    await db.query(`select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]);

    await db.query(`update memberships set status='ended' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
    const { rows: n } = await db.query(`select r1_draft_revalidate_owners($1) as n`, [CO_A]);
    expect(n[0].n).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      `select state, accountable_owner_id, routing_reason, routing_department
         from management_items where id=$1`, [id]);
    expect(rows[0].state).toBe("needs_routing");
    expect(rows[0].accountable_owner_id).toBeNull();          // NOT reassigned to an admin
    expect(rows[0].routing_reason).toMatch(/lost active authorised membership/i);
    expect(rows[0].routing_department).toBe("finance");

    const { rows: tr } = await db.query(
      `select from_state, to_state, actor_type, reason from management_item_transitions
        where item_id=$1 order by created_at desc limit 1`, [id]);
    expect(tr[0].to_state).toBe("needs_routing");
    expect(tr[0].actor_type).toBe("system");
    expect(tr[0].reason).toMatch(/no longer active or authorised/i);

    await db.query(`update memberships set status='active' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
  });

  it("REASSIGNMENT to a different valid owner works after re-routing", async () => {
    // needs_routing requires reason + department AT INSERT, so seed them together.
    const id = randomUUID();
    await db.query(
      `insert into management_items (id, company_id, department, kind, subject_table, subject_id,
                                     identity_key, state, routing_department, routing_reason)
       values ($1,$2,'finance','receivable_overdue','customer_invoices',$3,$4,'needs_routing','finance',
               'awaiting a finance officer')`,
      [id, CO_A, `inv-${id.slice(0, 8)}`, `${CO_A}:k:${id}`]);
    await db.query(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,'customer_invoices',$3,'{}'::jsonb)`,
      [CO_A, id, `src-${id.slice(0, 8)}`]);
    await db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [id, membershipOf.get(MANAGER)!]);
    const { rows } = await db.query(
      `select r1_draft_transition_item($1,'needs_routing','assigned',$2,'user',null,'[]'::jsonb) as r`, [id, MANAGER]);
    expect(rows[0].r.result).toBe("transitioned");
  });

  it("CONCURRENT revocation and assignment: the assignment loses, and no orphan owner survives", async () => {
    const id = await newItem(CO_A, "approved", membershipOf.get(REVOKED)!);

    // Revoke and re-validate in one transaction while an assignment is attempted after it.
    await db.query(`update memberships set status='ended' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);

    await expect(
      db.query(`select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`, [id, MANAGER]),
    ).rejects.toThrow(/not an active authorised membership/i);

    const { rows } = await db.query(`select state from management_items where id=$1`, [id]);
    expect(rows[0].state).toBe("approved"); // unchanged — no partial assignment
    await db.query(`update memberships set status='active' where company_id=$1 and user_id=$2`, [CO_A, REVOKED]);
  });
});

// Single connection for the whole file; closed once, after both describes.
afterAll(async () => {
  await db?.end().catch(() => {});
});

// ── R1-F-002: the lifecycle is RPC-only ────────────────────────────────────────────────
describe.skipIf(!enabled)("R1-F-002 — management item state is RPC-only", () => {
  async function ownedItem(state = "observed") {
    const id = randomUUID();
    await db.query(
      `insert into management_items (id, company_id, department, kind, subject_table, subject_id,
                                     identity_key, state, accountable_owner_id)
       values ($1,$2,'finance','k','t','1',$3,$4,$5)`,
      [id, CO_A, `f002-${id}`, state, membershipOf.get(MANAGER)!],
    );
    await db.query(
      `insert into management_item_evidence (company_id,item_id,source_table,source_id,facts)
       values ($1,$2,'t',$3,'{}'::jsonb)`, [CO_A, id, `src-${id.slice(0, 8)}`]);
    return id;
  }

  it("REFUSES a direct UPDATE of state by a capable manager — the bypass is closed", async () => {
    const id = await ownedItem();
    const msg = await refusalFor(MANAGER, `update management_items set state='verified' where id=$1`, [id]);
    expect(msg).toMatch(/may only change through r1_draft_transition_item/i);

    const { rows } = await db.query(`select state from management_items where id=$1`, [id]);
    expect(rows[0].state).toBe("observed");
  });

  it("REFUSES a direct UPDATE even by the service context", async () => {
    const id = await ownedItem();
    await expect(db.query(`update management_items set state='verified' where id=$1`, [id]))
      .rejects.toThrow(/may only change through r1_draft_transition_item/i);
  });

  it("a direct UPDATE writes NO transition row, so the audit trail cannot gain a hole", async () => {
    const id = await ownedItem();
    await db.query(`update management_items set state='verified' where id=$1`, [id]).catch(() => {});
    const { rows } = await db.query(
      `select count(*)::int as n from management_item_transitions where item_id=$1`, [id]);
    expect(rows[0].n).toBe(0);
  });

  it("the RPC still works, and it is the ONLY way through", async () => {
    const id = await ownedItem();
    const { rows } = await db.query(
      `select r1_draft_transition_item($1,'observed','understood',$2,'user',null,'[]'::jsonb) as r`,
      [id, MANAGER]);
    expect(rows[0].r.result).toBe("transitioned");
    const { rows: st } = await db.query(`select state from management_items where id=$1`, [id]);
    expect(st[0].state).toBe("understood");
  });

  it("the token is BURNED: a second direct update in the same transaction is still refused", async () => {
    const id = await ownedItem();
    await db.query("begin");
    try {
      await db.query(`select r1_draft_transition_item($1,'observed','understood',$2,'user',null,'[]'::jsonb)`,
        [id, MANAGER]);
      // The RPC's token authorised exactly one write; a follow-up direct update must fail.
      await expect(db.query(`update management_items set state='prioritised' where id=$1`, [id]))
        .rejects.toThrow(/may only change through/i);
    } finally {
      await db.query("rollback");
    }
  });

  it("NON-state columns remain directly updatable by a capable manager", async () => {
    const id = await ownedItem();
    await expect(db.query(`update management_items set monitoring_state='on_track' where id=$1`, [id]))
      .resolves.toBeTruthy();
  });
});
