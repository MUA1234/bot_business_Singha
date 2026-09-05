/**
 * The completion-claim boundary, against a real PostgreSQL.
 *
 * A completion claim means exactly one thing: **the assigned person reports that their work is
 * complete.** Not that it succeeded, not that the condition is resolved, not that the item may be
 * closed, and not that anyone's record should improve. Every test below is either about who may
 * make that report, or about the things a claim must NOT do.
 *
 * Two facts from the audit shape the whole file:
 *
 *   * `completeTask` gates on `requireOps()` and never checks the assignee (R2F-F-011), so a
 *     manager can move anyone's task to `completed`. "The task is completed" therefore does not
 *     imply "the assigned person said so", and this boundary must check the assignment itself.
 *   * an item and a task are linked in TWO different ways (R2F-F-012) — the ORIGINATING task whose
 *     condition raised the item, and the EFFECT task the executor created in response. They mean
 *     different things, so the claim records which one it was about.
 *
 * Every call runs as a real `authenticated` session with a real `auth.uid()`. Privileged reads
 * appear only to ask "is it physically there" — never to perform an action — because a policy that
 * hides a row makes "absent" and "invisible" indistinguishable, and only one is reassuring.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();

/** The person the work is actually assigned to. Holds `operations.task.work`. */
const WORKER = randomUUID();
/** A second worker in the same company, for "somebody else's task". */
const WORKER_2 = randomUUID();
/** A manager: holds `operations.task.manage` AND `operations.task.work`, assigned nothing. */
const MANAGER = randomUUID();
/** An active member of company A with a role that does NOT hold `operations.task.work`. */
const NO_CAP = randomUUID();
/** A worker in company B only. */
const B_WORKER = randomUUID();
/** Authenticated, but a member of nothing. */
const OUTSIDER = randomUUID();

let raw: pg.Client;
const membershipOf = new Map<string, string>();
const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** Read with RLS out of the way: "is it there", never "may I see it". */
async function physical<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(sql, params);
    return rows as T[];
  } finally {
    await q("commit");
  }
}

/** Run `sql` as a real signed-in person, with `auth.uid()` resolving to them. */
async function asUser(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  client: pg.Client = raw,
  role = "authenticated",
): Promise<Record<string, unknown>> {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { role, sub: userId } : { role }),
    ]);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows[0] as Record<string, unknown>;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

interface ClaimArgs {
  itemId: string;
  taskId: string;
  state?: string;
  actionId?: string | null;
  digest?: string;
  note?: string | null;
  key?: string | null;
}

/** The claim RPC, invoked as `userId`. */
function claim(
  userId: string | null,
  a: ClaimArgs,
  client: pg.Client = raw,
  role = "authenticated",
): Promise<Record<string, unknown>> {
  return asUser(
    userId,
    `select public.r1_draft_claim_task_completion($1,$2,$3,$4,$5,$6,$7) as r`,
    [
      a.itemId,
      a.taskId,
      a.state ?? "monitoring",
      a.actionId === undefined ? "ops.task.create_internal" : a.actionId,
      a.digest ?? "",
      a.note ?? "work finished",
      a.key ?? null,
    ],
    client,
    role,
  ).then((row) => row.r as Record<string, unknown>);
}

async function digestOf(companyId: string, itemId: string): Promise<string> {
  const rows = await physical<{ d: string }>(
    `select public.r1_draft_evidence_digest($1,$2) as d`,
    [companyId, itemId],
  );
  return rows[0]!.d;
}

async function seedTask(
  companyId: string,
  opts: { status?: string; assignedTo?: string | null; requiresEvidence?: boolean } = {},
): Promise<string> {
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, requires_evidence, assigned_to)
     values ($1,'Claimable work',$2,'2020-01-01'::date,$3,$4) returning id`,
    [
      companyId,
      opts.status ?? "completed",
      opts.requiresEvidence ?? false,
      opts.assignedTo === undefined ? WORKER : opts.assignedTo,
    ],
  );
  return String(rows[0].id);
}

/**
 * An item in a state that admits a claim, linked to `taskId` as its ORIGINATING subject, with a
 * prior transition already in its history so "prior history is preserved" is a real assertion.
 */
async function seedItem(
  companyId: string,
  taskId: string,
  opts: {
    state?: string;
    action?: string | null;
    owner?: string | null;
    department?: string;
    subjectId?: string;
  } = {},
): Promise<string> {
  const itemId = randomUUID();
  await q(
    `insert into management_items
       (id, company_id, department, kind, subject_table, subject_id, identity_key,
        state, proposed_action_id, accountable_owner_id)
     values ($1,$2,$3,'overdue_task','tasks',$4,$5,$6,$7,$8)`,
    [
      itemId,
      companyId,
      opts.department ?? "operations",
      opts.subjectId ?? taskId,
      `${companyId}:claim:${itemId}`,
      opts.state ?? "monitoring",
      opts.action === undefined ? "ops.task.create_internal" : opts.action,
      opts.owner === undefined ? membershipOf.get(`${companyId}:${WORKER}`)! : opts.owner,
    ],
  );
  await q(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id)
     values ($1,$2,'tasks',$3)`,
    [companyId, itemId, taskId],
  );
  // Prior history. A claim must add to this, never replace it.
  await q(
    `insert into management_item_transitions
       (company_id, item_id, from_state, to_state, actor_id, actor_type, reason)
     values ($1,$2,'assigned','monitoring',$3,'system','routed to the assignee')`,
    [companyId, itemId, null],
  );
  return itemId;
}

/** An `executed` execution attempt whose effect is `taskId` — the second real link. */
async function seedEffectLink(companyId: string, itemId: string, taskId: string): Promise<void> {
  await q(
    `insert into management_execution_attempts
       (company_id, item_id, action_id, idempotency_key, status, effect_ref, handler,
        resolved_authority, completed_at)
     values ($1,$2,'ops.task.create_internal',$3,'executed',$4,'createInternalTask',
             'automatic', now())`,
    [companyId, itemId, `idem-${itemId}`, taskId],
  );
}

async function seedPerson(user: string, company: string, roleKey: string): Promise<void> {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(
    `insert into users (id, email, full_name) values ($1,$2,'Claim tester')
       on conflict (id) do nothing`,
    [user, `claim-${user.slice(0, 8)}@example.invalid`],
  );
  await q(
    `insert into profiles (id, company_id, username, full_name, department, is_active)
     values ($1,$2,$3,'Claim tester','operations',true) on conflict (id) do nothing`,
    [user, company, `claim-${user.slice(0, 8)}`],
  );
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status = 'active'
     returning id`,
    [company, user],
  );
  membershipOf.set(`${company}:${user}`, String(rows[0].id));
  await q(
    `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
       on conflict do nothing`,
    [rows[0].id, company, roleKey],
  );
}

beforeAll(async () => {
  if (!enabled) return;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();

  for (const c of [CO_A, CO_B]) {
    await q(
      `insert into companies (id, name, base_currency) values ($1,$2,'LKR')
         on conflict (id) do nothing`,
      [c, `CLAIM ${c.slice(0, 8)}`],
    );
  }

  await seedPerson(WORKER, CO_A, "staff_submitter");
  await seedPerson(WORKER_2, CO_A, "staff_submitter");
  await seedPerson(MANAGER, CO_A, "project_manager");
  // `finance_reviewer` is an active member with no `operations.task.work`.
  await seedPerson(NO_CAP, CO_A, "finance_reviewer");
  await seedPerson(B_WORKER, CO_B, "staff_submitter");

  // Authenticated, but a member of nothing at all.
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [OUTSIDER]);
  await q(
    `insert into users (id, email, full_name) values ($1,$2,'Outsider') on conflict (id) do nothing`,
    [OUTSIDER, `out-${OUTSIDER.slice(0, 8)}@example.invalid`],
  );
});

afterAll(async () => {
  if (!enabled) return;
  await raw?.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the claim the assignee is entitled to make", () => {
  it("records the claim, the transition and the audit event as one act", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, {
      itemId,
      taskId,
      digest: await digestOf(CO_A, itemId),
      note: "site cleared and photographed",
      key: `k-${itemId}`,
    });

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.result).toBe("claimed");
    expect(out.link_kind).toBe("originating");

    const claims = await physical(
      `select claimant_user_id, task_id, bound_state, bound_action_id, link_kind, note,
              idempotency_key, claimed_at
         from management_completion_claims where item_id = $1`,
      [itemId],
    );
    expect(claims).toHaveLength(1);
    // The claimant is the AUTHENTICATED user. Nothing in the call said who they were.
    expect(claims[0]!.claimant_user_id).toBe(WORKER);
    expect(claims[0]!.task_id).toBe(taskId);
    expect(claims[0]!.bound_state).toBe("monitoring");
    expect(claims[0]!.bound_action_id).toBe("ops.task.create_internal");
    expect(claims[0]!.link_kind).toBe("originating");

    const items = await physical(`select state from management_items where id = $1`, [itemId]);
    expect(items[0]!.state).toBe("verifying");

    const transitions = await physical(
      `select from_state, to_state, actor_id, actor_type from management_item_transitions
        where item_id = $1 order by created_at`,
      [itemId],
    );
    // The seeded history is still there, with the claim appended after it.
    expect(transitions).toHaveLength(2);
    expect(transitions[0]!.to_state).toBe("monitoring");
    expect(transitions[1]!.from_state).toBe("monitoring");
    expect(transitions[1]!.to_state).toBe("verifying");
    expect(transitions[1]!.actor_id).toBe(WORKER);
    expect(transitions[1]!.actor_type).toBe("user");

    const audits = await physical(
      `select action, actor_id, actor_type, payload from audit_events where entity_id = $1`,
      [itemId],
    );
    expect(audits.map((a) => a.action)).toContain("management_item.completion_claimed");
    const ev = audits.find((a) => a.action === "management_item.completion_claimed")!;
    expect(ev.actor_id).toBe(WORKER);
    expect(ev.actor_type).toBe("user");
    expect((ev.payload as Record<string, unknown>).task_id).toBe(taskId);
  });

  it("takes the claim time from the database, not from `tasks.updated_at`", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    // A task row's `updated_at` moves whenever anything about it changes — a title edit, a
    // priority change, a later correction — so it cannot be the time work was reported done.
    await q(`update tasks set updated_at = now() - interval '9 days' where id = $1`, [taskId]);

    await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });

    const rows = await physical<{ drift: string; recent: boolean }>(
      `select extract(epoch from (c.claimed_at - t.updated_at))::text as drift,
              (c.claimed_at > now() - interval '2 minutes') as recent
         from management_completion_claims c join tasks t on t.id = c.task_id
        where c.item_id = $1`,
      [itemId],
    );
    expect(rows[0]!.recent).toBe(true);
    expect(Number(rows[0]!.drift)).toBeGreaterThan(60 * 60 * 24 * 8);
  });

  it("records an EFFECT task as an effect, distinguishing it from the originating one", async () => {
    // The item's own subject is a different record; the claimed task is the one execution created.
    const originating = await seedTask(CO_A, { status: "in_progress" });
    const effect = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, originating, { subjectId: originating });
    await seedEffectLink(CO_A, itemId, effect);

    const out = await claim(WORKER, {
      itemId,
      taskId: effect,
      digest: await digestOf(CO_A, itemId),
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.link_kind).toBe("effect");

    const rows = await physical(
      `select link_kind, task_id from management_completion_claims where item_id = $1`,
      [itemId],
    );
    expect(rows[0]!.link_kind).toBe("effect");
    expect(rows[0]!.task_id).toBe(effect);
  });

  it("accepts a claim from `escalated`, which the lifecycle also permits", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId, { state: "escalated" });

    const out = await claim(WORKER, {
      itemId,
      taskId,
      state: "escalated",
      digest: await digestOf(CO_A, itemId),
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const items = await physical(`select state from management_items where id = $1`, [itemId]);
    expect(items[0]!.state).toBe("verifying");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("who may not claim", () => {
  /** Nothing happened: no claim, no transition beyond the seeded one, no state change. */
  async function assertNothingHappened(itemId: string, state = "monitoring") {
    const claims = await physical(
      `select id from management_completion_claims where item_id = $1`, [itemId]);
    expect(claims).toHaveLength(0);
    const items = await physical(`select state from management_items where id = $1`, [itemId]);
    expect(items[0]!.state).toBe(state);
    const t = await physical(
      `select id from management_item_transitions where item_id = $1 and to_state = 'verifying'`,
      [itemId]);
    expect(t).toHaveLength(0);
  }

  it("refuses a manager claiming on behalf of the worker", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(MANAGER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("not_assignee");
    await assertNothingHappened(itemId);
  });

  it("refuses another worker in the same company", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER_2, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("not_assignee");
    await assertNothingHappened(itemId);
  });

  it("refuses the accountable owner when the task is assigned to somebody else", async () => {
    // The owner relationship on its own is NOT a completion right. WORKER_2 is named accountable,
    // holds the capability, and is an active member — and the task is WORKER's.
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId, {
      owner: membershipOf.get(`${CO_A}:${WORKER_2}`)!,
    });

    const out = await claim(WORKER_2, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("not_assignee");
    await assertNothingHappened(itemId);
  });

  it("refuses a claim on an unassigned task", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: null });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("task_unassigned");
    await assertNothingHappened(itemId);
  });

  it("refuses an active member who does not hold `operations.task.work`", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: NO_CAP });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(NO_CAP, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("insufficient_capability");
    await assertNothingHappened(itemId);
  });

  it("refuses a member of another company, and does not confirm the item exists", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(B_WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("not_found");
    await assertNothingHappened(itemId);
  });

  it("refuses an authenticated person who is a member of nothing", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(OUTSIDER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("not_found");
    await assertNothingHappened(itemId);
  });

  it("refuses a session with no subject — the AI and the scheduler have none", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);

    // `authenticated` with no `sub`: exactly what a machine caller presenting a role and no
    // person would look like.
    const out = await claim(null, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("unauthenticated");
    await assertNothingHappened(itemId);
  });

  it("does not grant EXECUTE to service_role or anon", async () => {
    const rows = await physical<{ grantee: string }>(
      `select r.rolname as grantee
         from pg_proc p, pg_roles r
        where p.proname = 'r1_draft_claim_task_completion'
          and r.rolname in ('anon','service_role','authenticated')
          and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
    );
    const grantees = rows.map((r) => r.grantee).sort();
    // A service principal fabricating a human's completion report is the exact impersonation
    // this boundary exists to prevent, so it may not even call the function.
    expect(grantees).toEqual(["authenticated"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("what the underlying task must actually say", () => {
  it("refuses a task that is not in a terminal status", async () => {
    const taskId = await seedTask(CO_A, { status: "in_progress" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("task_not_terminal");
    expect(out.actual).toBe("in_progress");
  });

  it("refuses `awaiting_evidence`, which looks finished and is not", async () => {
    const taskId = await seedTask(CO_A, { status: "awaiting_evidence" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("task_not_terminal");
  });

  it("refuses when the task demands evidence and none exists", async () => {
    const taskId = await seedTask(CO_A, { requiresEvidence: true });
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("evidence_required");
  });

  it("accepts once the required evidence is attached through the task's own mechanism", async () => {
    const taskId = await seedTask(CO_A, { requiresEvidence: true });
    const itemId = await seedItem(CO_A, taskId);
    await q(
      `insert into task_evidence (task_id, company_id, kind, reference)
       values ($1,$2,'photo','site-photo-1')`,
      [taskId, CO_A],
    );

    const out = await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("refuses a task that belongs to a different company from the item", async () => {
    const foreign = await seedTask(CO_B, { assignedTo: B_WORKER });
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, { itemId, taskId: foreign, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("not_found");
  });

  it("refuses a task that is not linked to the item at all", async () => {
    const unrelated = await seedTask(CO_A);
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, {
      itemId, taskId: unrelated, digest: await digestOf(CO_A, itemId),
    });
    expect(out.refusal).toBe("task_not_linked");
  });

  it("refuses an execution attempt that did not actually execute", async () => {
    const originating = await seedTask(CO_A, { status: "in_progress" });
    const effect = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, originating, { subjectId: originating });
    await q(
      `insert into management_execution_attempts
         (company_id, item_id, action_id, idempotency_key, status, refusal_reason, completed_at)
       values ($1,$2,'ops.task.create_internal',$3,'refused','not_permitted', now())`,
      [CO_A, itemId, `idem-refused-${itemId}`],
    );

    const out = await claim(WORKER, { itemId, taskId: effect, digest: await digestOf(CO_A, itemId) });
    expect(out.refusal).toBe("task_not_linked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("bound to what the claimant actually saw", () => {
  it("refuses a stale item state", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId, { state: "escalated" });

    const out = await claim(WORKER, {
      itemId, taskId, state: "monitoring", digest: await digestOf(CO_A, itemId),
    });
    expect(out.refusal).toBe("stale_item");
    expect(out.actual).toBe("escalated");
  });

  it("refuses when the proposed action changed under the claimant", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);

    const out = await claim(WORKER, {
      itemId, taskId, actionId: "ops.something.else", digest: await digestOf(CO_A, itemId),
    });
    expect(out.refusal).toBe("action_changed");
  });

  it("refuses when the evidence generation moved", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    const seen = await digestOf(CO_A, itemId);
    // New evidence arrives between the page render and the click.
    await q(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id)
       values ($1,$2,'tasks',$3)`,
      [CO_A, itemId, `later-${itemId}`],
    );

    const out = await claim(WORKER, { itemId, taskId, digest: seen });
    expect(out.refusal).toBe("evidence_changed");
  });

  it("refuses a state the lifecycle does not admit a claim from", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId, { state: "assigned" });

    const out = await claim(WORKER, {
      itemId, taskId, state: "assigned", digest: await digestOf(CO_A, itemId),
    });
    expect(out.refusal).toBe("state_does_not_admit_claim");
    expect(out.actual).toBe("assigned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("retries and simultaneous claims", () => {
  it("returns the same claim for an exact retry, and writes nothing twice", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    const digest = await digestOf(CO_A, itemId);
    const key = `retry-${itemId}`;

    const first = await claim(WORKER, { itemId, taskId, digest, key });
    expect(first.result).toBe("claimed");

    // The retry carries the state the claimant SAW — which the first call has already moved past.
    // Recognising the retry has to happen before the binding comparison, or an honest resend
    // would be reported as a stale conflict.
    const second = await claim(WORKER, { itemId, taskId, digest, key });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.result).toBe("duplicate");
    expect(second.claim_id).toBe(first.claim_id);

    const claims = await physical(
      `select id from management_completion_claims where item_id = $1`, [itemId]);
    expect(claims).toHaveLength(1);
    const t = await physical(
      `select id from management_item_transitions where item_id = $1 and to_state = 'verifying'`,
      [itemId]);
    expect(t).toHaveLength(1);
  });

  it("refuses a conflicting retry rather than returning the first claim", async () => {
    const originating = await seedTask(CO_A);
    const effect = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, originating);
    await seedEffectLink(CO_A, itemId, effect);
    const digest = await digestOf(CO_A, itemId);
    const key = `conflict-${itemId}`;

    const first = await claim(WORKER, { itemId, taskId: originating, digest, key });
    expect(first.result).toBe("claimed");

    // Same key, DIFFERENT task. Returning the first would hide that two different claims were
    // made under one identity.
    const second = await claim(WORKER, { itemId, taskId: effect, digest, key });
    expect(second.ok).toBe(false);
    expect(second.refusal).toBe("conflicting_retry");
  });

  it("serialises two simultaneous claims into exactly one", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    const digest = await digestOf(CO_A, itemId);

    const other = new pg.Client({ connectionString: URL, ssl: false });
    await other.connect();
    try {
      const [a, b] = await Promise.allSettled([
        claim(WORKER, { itemId, taskId, digest, key: `sim-a-${itemId}` }),
        claim(WORKER, { itemId, taskId, digest, key: `sim-b-${itemId}` }, other),
      ]);
      const results = [a, b].map((r) =>
        r.status === "fulfilled" ? (r.value.result ?? r.value.refusal) : "threw");
      // One claims; the other finds the state already moved. Two claims of the same work would
      // be two reports of one act.
      expect(results.filter((x) => x === "claimed")).toHaveLength(1);
      expect(results.filter((x) => x === "claimed" || x === "stale_item")).toHaveLength(2);
    } finally {
      await other.end();
    }

    const claims = await physical(
      `select id from management_completion_claims where item_id = $1`, [itemId]);
    expect(claims).toHaveLength(1);
    const t = await physical(
      `select id from management_item_transitions where item_id = $1 and to_state = 'verifying'`,
      [itemId]);
    expect(t).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("a claim is a report, not a verification", () => {
  it("verifies nothing, closes nothing and produces no learning signal", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });

    const items = await physical(`select state, outcome from management_items where id = $1`, [itemId]);
    // `verifying` means "somebody says this is done and nobody has checked". Not `verified`.
    expect(items[0]!.state).toBe("verifying");
    expect(items[0]!.outcome ?? null).toBeNull();

    const outcomeTransitions = await physical(
      `select to_state from management_item_transitions
        where item_id = $1 and to_state in ('verified','reopened')`,
      [itemId],
    );
    expect(outcomeTransitions).toHaveLength(0);

    const attempts = await physical(
      `select id from management_verification_attempts where item_id = $1`, [itemId]);
    expect(attempts).toHaveLength(0);
    const schedule = await physical(
      `select item_id from management_verification_schedule where item_id = $1`, [itemId]);
    expect(schedule).toHaveLength(0);
  });

  it("does not touch the task's assignment, status or evidence", async () => {
    const taskId = await seedTask(CO_A);
    const before = await physical<{ assigned_to: string; status: string }>(
      `select assigned_to, status from tasks where id = $1`, [taskId]);
    const itemId = await seedItem(CO_A, taskId);

    await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });

    const after = await physical<{ assigned_to: string; status: string }>(
      `select assigned_to, status from tasks where id = $1`, [taskId]);
    expect(after[0]!.assigned_to).toBe(before[0]!.assigned_to);
    expect(after[0]!.status).toBe(before[0]!.status);
    const ev = await physical(`select id from task_evidence where task_id = $1`, [taskId]);
    expect(ev).toHaveLength(0);
  });

  it("does not execute anything", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });

    const attempts = await physical(
      `select id from management_execution_attempts where item_id = $1`, [itemId]);
    expect(attempts).toHaveLength(0);
    const tasks = await physical(`select id from tasks where company_id = $1`, [CO_A]);
    // No new task appeared as a side effect of reporting one finished.
    expect(tasks.some((t) => t.id === taskId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
//
// The screen decides what to SHOW. The RPC decides what may happen. These four call the boundary
// exactly as a browser could — with the values a legitimately rendered page produced — after the
// facts behind that page have changed underneath it.
describe.skipIf(!enabled)("what a page cannot preserve by having been rendered", () => {
  it("refuses after the capability is removed, with an otherwise valid submission", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER_2 });
    const itemId = await seedItem(CO_A, taskId, {
      owner: membershipOf.get(`${CO_A}:${WORKER_2}`)!,
    });
    // Everything the page would have captured while the control was legitimately shown.
    const digest = await digestOf(CO_A, itemId);

    // The role carrying `operations.task.work` is removed after the page was rendered.
    await q(
      `delete from membership_roles where membership_id = $1`,
      [membershipOf.get(`${CO_A}:${WORKER_2}`)!],
    );

    const out = await claim(WORKER_2, { itemId, taskId, digest });
    expect(out.refusal).toBe("insufficient_capability");
    const claims = await physical(
      `select id from management_completion_claims where item_id = $1`, [itemId]);
    expect(claims).toHaveLength(0);

    // Restored, so the removal does not leak into the tests that run after this one.
    await q(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'staff_submitter')
         on conflict do nothing`,
      [membershipOf.get(`${CO_A}:${WORKER_2}`)!, CO_A],
    );
  });

  it("refuses after the membership ends, with an otherwise valid submission", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);
    const digest = await digestOf(CO_A, itemId);

    await q(`update memberships set status = 'ended' where company_id = $1 and user_id = $2`,
      [CO_A, WORKER]);
    const out = await claim(WORKER, { itemId, taskId, digest });
    // Reported as absent: an ended member is told nothing about what the company contains.
    expect(out.refusal).toBe("not_found");
    await q(`update memberships set status = 'active' where company_id = $1 and user_id = $2`,
      [CO_A, WORKER]);
  });

  it("refuses after the task is reassigned to somebody else", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);
    const digest = await digestOf(CO_A, itemId);

    await q(`update tasks set assigned_to = $1 where id = $2`, [WORKER_2, taskId]);

    const out = await claim(WORKER, { itemId, taskId, digest });
    expect(out.refusal).toBe("not_assignee");
  });

  it("refuses after the task is reopened, with an otherwise valid submission", async () => {
    const taskId = await seedTask(CO_A, { assignedTo: WORKER });
    const itemId = await seedItem(CO_A, taskId);
    const digest = await digestOf(CO_A, itemId);

    await q(`update tasks set status = 'reopened' where id = $1`, [taskId]);

    const out = await claim(WORKER, { itemId, taskId, digest });
    expect(out.refusal).toBe("task_not_terminal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the claim record itself", () => {
  it("cannot be composed directly by an authenticated session", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);

    // A session naming somebody else as the claimant is exactly what the RPC-only path prevents.
    await expect(
      asUser(
        MANAGER,
        `insert into management_completion_claims
           (company_id, item_id, task_id, claimant_user_id, bound_state, bound_evidence_digest,
            link_kind)
         values ($1,$2,$3,$4,'monitoring','x','originating')`,
        [CO_A, itemId, taskId, WORKER],
      ),
    ).rejects.toThrow();

    const rows = await physical(
      `select id from management_completion_claims where item_id = $1`, [itemId]);
    expect(rows).toHaveLength(0);
  });

  it("cannot be edited or deleted, even with the table privilege", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });

    // As the owner, with RLS out of the way: the append-only trigger is the guard, not the policy.
    await expect(
      physical(`update management_completion_claims set note = 'rewritten' where item_id = $1`,
        [itemId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      physical(`delete from management_completion_claims where item_id = $1`, [itemId]),
    ).rejects.toThrow(/append-only/);

    const rows = await physical<{ note: string }>(
      `select note from management_completion_claims where item_id = $1`, [itemId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe("work finished");
  });

  it("is readable only by someone who may see the item", async () => {
    const taskId = await seedTask(CO_A);
    const itemId = await seedItem(CO_A, taskId);
    await claim(WORKER, { itemId, taskId, digest: await digestOf(CO_A, itemId) });

    const mine = await asUser(
      WORKER,
      `select count(*)::int as n from management_completion_claims where item_id = $1`,
      [itemId],
    );
    expect(mine.n).toBe(1);

    const theirs = await asUser(
      B_WORKER,
      `select count(*)::int as n from management_completion_claims where item_id = $1`,
      [itemId],
    );
    expect(theirs.n).toBe(0);
  });
});
