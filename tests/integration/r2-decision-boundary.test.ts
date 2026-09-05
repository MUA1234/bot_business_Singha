/**
 * The management decision boundary, against a real PostgreSQL.
 *
 * Nothing in the application could record a decision before this: `management_item_decisions` had a
 * read policy and no insert policy, and item state moves only through `r1_draft_transition_item()`.
 * The queue rendered `approved` and `rejected` states that no runtime path could produce
 * (R2E-F-011 / R2F-F-002).
 *
 * Every call here runs as a real `authenticated` session with a real `auth.uid()` — never as the
 * service role, and never with `supabaseAdmin`. Hiding a button is not an authorisation boundary,
 * so the function is called directly and asked to refuse.
 *
 * Privileged reads appear only where the question is "is it physically there", never to perform an
 * action. R2D-F-006 is why: a policy that hides a row makes "absent" and "invisible"
 * indistinguishable, and only one of them is reassuring.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { evidenceDigest } from "@/components/spatial/panels/evidence-digest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
/** A manager in company A: holds `approve` and `reject` through `project_manager`. */
const MANAGER = randomUUID();
/** A second manager, for the simultaneous-decision cases. */
const MANAGER_2 = randomUUID();
/** Staff: an active member with no approval capability. */
const STAFF = randomUUID();
/** A manager in company B only. */
const B_MANAGER = randomUUID();

let raw: pg.Client;
const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** Read with RLS out of the way: "is it there", never "can I see it". */
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

/**
 * Call the RPC as a real signed-in person.
 *
 * `request.jwt.claims` carries the role AND the subject, so `auth.uid()` resolves to this user and
 * `has_capability` evaluates against their real memberships and roles.
 */
async function asUser(
  userId: string,
  sql: string,
  params: unknown[] = [],
  client: pg.Client = raw,
): Promise<Record<string, unknown>> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows[0] as Record<string, unknown>;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

/** The decision RPC, invoked as `userId`. */
function decide(
  userId: string,
  args: {
    itemId: string;
    decision: string;
    state?: string;
    actionId?: string | null;
    evidenceDigest?: string;
    parameterDigest?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  },
  client: pg.Client = raw,
) {
  return asUser(
    userId,
    `select public.r1_draft_record_management_decision($1,$2,$3,$4,$5,$6,$7,$8) as r`,
    [
      args.itemId,
      args.decision,
      args.state ?? "awaiting_approval",
      args.actionId === undefined ? "ops.task.create_internal" : args.actionId,
      args.evidenceDigest ?? "",
      args.parameterDigest ?? null,
      args.reason ?? null,
      args.idempotencyKey ?? null,
    ],
    client,
  ).then((row) => row.r as Record<string, unknown>);
}

async function digestOf(companyId: string, itemId: string): Promise<string> {
  const rows = await physical<{ d: string }>(
    `select public.r1_draft_evidence_digest($1,$2) as d`,
    [companyId, itemId],
  );
  return rows[0]!.d;
}

/** One item awaiting approval, with evidence. */
async function seedItem(
  companyId: string,
  opts: { state?: string; action?: string | null; authority?: string } = {},
): Promise<string> {
  const itemId = randomUUID();
  await q(
    `insert into management_items
       (id, company_id, department, kind, subject_table, subject_id, identity_key,
        state, proposed_action_id, required_authority)
     values ($1,$2,'operations','overdue_task','tasks',$3,$4,$5,$6,$7)`,
    [
      itemId, companyId, `subj-${itemId}`, `${companyId}:dec:${itemId}`,
      opts.state ?? "awaiting_approval",
      opts.action === undefined ? "ops.task.create_internal" : opts.action,
      opts.authority ?? "manager_approval",
    ],
  );
  await q(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id)
     values ($1,$2,'tasks',$3)`,
    [companyId, itemId, `ev-${itemId}`],
  );
  return itemId;
}

beforeAll(async () => {
  if (!enabled) return;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();

  for (const c of [CO_A, CO_B]) {
    await q(
      `insert into companies (id, name, base_currency) values ($1,$2,'LKR')
         on conflict (id) do nothing`,
      [c, `DEC ${c.slice(0, 8)}`],
    );
  }

  const people: Array<[string, string, string]> = [
    [MANAGER, CO_A, "project_manager"],
    [MANAGER_2, CO_A, "project_manager"],
    [STAFF, CO_A, "staff_submitter"],
    [B_MANAGER, CO_B, "project_manager"],
  ];
  for (const [user, company, role] of people) {
    await q(
      `insert into users (id, email, full_name) values ($1,$2,'Decision tester')
         on conflict (id) do nothing`,
      [user, `dec-${user.slice(0, 8)}@example.invalid`],
    );
    const { rows } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
         on conflict (company_id, user_id) do update set status = 'active'
       returning id`,
      [company, user],
    );
    await q(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
         on conflict do nothing`,
      [rows[0].id, company, role],
    );
  }
});

afterAll(async () => {
  if (!enabled) return;
  await raw?.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("decision boundary — the path that works", () => {
  it("a manager approves, and the decision, transition and audit all land", async () => {
    const itemId = await seedItem(CO_A);
    const out = await decide(MANAGER, {
      itemId,
      decision: "approve",
      evidenceDigest: await digestOf(CO_A, itemId),
      parameterDigest: "param-digest-1",
      idempotencyKey: `k-${itemId}`,
    });

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.result).toBe("recorded");
    expect(out.to_state).toBe("approved");

    const decisions = await physical(
      `select decision, actor_id, authority_level, bound_state, bound_action_id,
              bound_evidence_digest, bound_parameter_digest
         from management_item_decisions where item_id = $1`,
      [itemId],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe("approve");
    expect(decisions[0]!.actor_id).toBe(MANAGER);
    // Bound to exactly what was on screen.
    expect(decisions[0]!.bound_state).toBe("awaiting_approval");
    expect(decisions[0]!.bound_action_id).toBe("ops.task.create_internal");
    expect(decisions[0]!.bound_parameter_digest).toBe("param-digest-1");

    const items = await physical(`select state from management_items where id = $1`, [itemId]);
    expect(items[0]!.state).toBe("approved");

    const transitions = await physical(
      `select from_state, to_state, actor_id from management_item_transitions
        where item_id = $1 and to_state = 'approved'`,
      [itemId],
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from_state).toBe("awaiting_approval");

    const audits = await physical(
      `select action, actor_id from audit_events where entity_id = $1`,
      [itemId],
    );
    expect(audits.map((a) => a.action)).toContain("management_item.approve");
  });

  it("a manager rejects WITH a reason", async () => {
    const itemId = await seedItem(CO_A);
    const out = await decide(MANAGER, {
      itemId,
      decision: "reject",
      evidenceDigest: await digestOf(CO_A, itemId),
      reason: "the invoice was already settled by hand",
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.to_state).toBe("rejected");

    const items = await physical(`select state from management_items where id = $1`, [itemId]);
    expect(items[0]!.state).toBe("rejected");
  });

  it("refuses a rejection with no reason, and writes nothing", async () => {
    const itemId = await seedItem(CO_A);
    const out = await decide(MANAGER, {
      itemId,
      decision: "reject",
      evidenceDigest: await digestOf(CO_A, itemId),
      reason: "   ",
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("reason_required");
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
    const items = await physical(`select state from management_items where id = $1`, [itemId]);
    expect(items[0]!.state).toBe("awaiting_approval");
  });
});

describe.skipIf(!enabled)("decision boundary — who may decide", () => {
  it("refuses an unauthenticated caller", async () => {
    const itemId = await seedItem(CO_A);
    // No `sub` claim, so `auth.uid()` is null.
    await q("begin");
    let out: Record<string, unknown>;
    try {
      await q("set local role authenticated");
      await q(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      const { rows } = await q(
        `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',
                 'ops.task.create_internal','','p',null,null) as r`,
        [itemId],
      );
      out = rows[0].r;
    } finally {
      await q("commit");
    }
    expect(out!.ok).toBe(false);
    expect(out!.refusal).toBe("unauthenticated");
  });

  it("refuses STAFF, who are active members without approval capability", async () => {
    const itemId = await seedItem(CO_A);
    const out = await decide(STAFF, {
      itemId,
      decision: "approve",
      evidenceDigest: await digestOf(CO_A, itemId),
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("insufficient_capability");
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
  });

  it("refuses a member whose membership has been REVOKED", async () => {
    const itemId = await seedItem(CO_A);
    await q(`update memberships set status='ended' where user_id=$1 and company_id=$2`, [
      MANAGER_2, CO_A,
    ]);
    try {
      const out = await decide(MANAGER_2, {
        itemId,
        decision: "approve",
        evidenceDigest: await digestOf(CO_A, itemId),
      });
      expect(out.ok).toBe(false);
      // An inactive member is not a member: the item reads as absent.
      expect(out.refusal).toBe("not_found");
    } finally {
      await q(`update memberships set status='active' where user_id=$1 and company_id=$2`, [
        MANAGER_2, CO_A,
      ]);
    }
  });

  it("TENANT ISOLATION — a manager of company B cannot decide company A's item", async () => {
    const itemId = await seedItem(CO_A);
    const out = await decide(B_MANAGER, {
      itemId,
      decision: "approve",
      evidenceDigest: await digestOf(CO_A, itemId),
    });
    expect(out.ok).toBe(false);
    // Indistinguishable from absent: telling a stranger the item exists is itself a disclosure.
    expect(out.refusal).toBe("not_found");
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
  });

  it("has no parameter through which a caller could supply a company or membership", async () => {
    // The signature is the boundary. Eight parameters, none of them an identity.
    const rows = await physical<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='r1_draft_record_management_decision'`,
    );
    expect(rows).toHaveLength(1);
    const args = rows[0]!.args;
    for (const forbidden of ["company", "membership", "actor", "authority", "user"]) {
      expect(args.includes(forbidden), `signature must not accept ${forbidden}: ${args}`).toBe(
        false,
      );
    }
  });
});

describe.skipIf(!enabled)("decision boundary — bound to what was seen", () => {
  it("refuses a STALE item state", async () => {
    const itemId = await seedItem(CO_A, { state: "recommended" });
    const out = await decide(MANAGER, {
      itemId,
      decision: "approve",
      state: "awaiting_approval",
      evidenceDigest: await digestOf(CO_A, itemId),
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("stale_item");
    expect(out.actual).toBe("recommended");
  });

  it("refuses when the proposed ACTION changed under the reviewer", async () => {
    const itemId = await seedItem(CO_A, { action: "ops.task.escalate_internal" });
    const out = await decide(MANAGER, {
      itemId,
      decision: "approve",
      actionId: "ops.task.create_internal",
      evidenceDigest: await digestOf(CO_A, itemId),
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("action_changed");
  });

  it("refuses when the EVIDENCE changed, even though the item did not", async () => {
    const itemId = await seedItem(CO_A);
    const seen = await digestOf(CO_A, itemId);
    // Evidence is append-only, so it changes by accretion — a detector observing something new.
    await q(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id)
       values ($1,$2,'tasks',$3)`,
      [CO_A, itemId, `ev-later-${itemId}`],
    );
    const out = await decide(MANAGER, {
      itemId, decision: "approve", evidenceDigest: seen,
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("evidence_changed");
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
  });

  it("refuses from a state that does not admit a decision, including terminal ones", async () => {
    // `assigned` and `monitoring` are excluded deliberately: `management_items_owner_required_ck`
    // demands an accountable owner for them, so seeding one without an owner would be seeding a
    // contradiction rather than a test.
    // `needs_routing` is excluded too: `management_items_routing_reason_ck` requires a routing
    // reason for it. Each of these constraints is the product refusing an incoherent row.
    for (const state of ["observed", "recommended", "approved", "reopened"]) {
      const itemId = await seedItem(CO_A, { state });
      const out = await decide(MANAGER, {
        itemId, decision: "approve", state,
        evidenceDigest: await digestOf(CO_A, itemId),
      });
      expect(out.ok, state).toBe(false);
      expect(out.refusal, state).toBe("state_does_not_admit_decision");
    }
  });

  it("refuses an item that was ALREADY decided", async () => {
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);
    expect((await decide(MANAGER, { itemId, decision: "approve", evidenceDigest: d })).ok).toBe(true);

    // The reviewer's screen still says `awaiting_approval`, so the refusal names the thing that
    // actually changed — the item moved under them — rather than the downstream consequence.
    const second = await decide(MANAGER, { itemId, decision: "approve", evidenceDigest: d });
    expect(second.ok).toBe(false);
    expect(second.refusal).toBe("stale_item");
    expect(second.actual).toBe("approved");

    // And a reviewer whose screen is CURRENT is refused by the state gate instead.
    const third = await decide(MANAGER, {
      itemId, decision: "approve", state: "approved", evidenceDigest: d,
    });
    expect(third.ok).toBe(false);
    expect(third.refusal).toBe("state_does_not_admit_decision");
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(1);
  });

  it("refuses an unknown or malformed decision type, and records it as unresolved", async () => {
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);
    for (const decision of ["dismiss", "edit", "delegate", "DROP TABLE", "", "approve "]) {
      const out = await decide(MANAGER, { itemId, decision, evidenceDigest: d });
      expect(out.ok, decision).toBe(false);
      expect(out.refusal, decision).toBe("unresolved_authority");
    }
  });

  /**
   * CORRECTED. This asserted that both elevated levels refuse with `unresolved_authority` and a
   * detail naming the authority. The RPC does something more useful and the assertion was simply
   * wrong about it — it had never run green, because the campaign at that checkpoint was deferred.
   *
   * The two refusals are DIFFERENT, deliberately: "nobody can decide this here" and "you cannot
   * decide this" call for different actions from the person reading them. Collapsing them would
   * send someone looking for a colleague with a permission that does not exist.
   */
  it("distinguishes an unregistered authority from one this person does not hold", async () => {
    // Ten of the twelve domains have no registered specialist capability. Operations is one, so
    // NOBODY can take this decision, and the refusal names the domain.
    const specialist = await seedItem(CO_A, { authority: "specialist_approval" });
    const outSpecialist = await decide(MANAGER, {
      itemId: specialist, decision: "approve", evidenceDigest: await digestOf(CO_A, specialist),
    });
    expect(outSpecialist.ok).toBe(false);
    expect(outSpecialist.refusal).toBe("unresolved_authority");
    expect(String(outSpecialist.detail)).toContain("operations");
    expect(String(outSpecialist.detail)).toContain("no specialist capability is registered");

    // Owner approval IS a registered capability. This manager does not hold it, which is a
    // different fact and a different refusal.
    const owner = await seedItem(CO_A, { authority: "owner_approval" });
    const outOwner = await decide(MANAGER, {
      itemId: owner, decision: "approve", evidenceDigest: await digestOf(CO_A, owner),
    });
    expect(outOwner.ok).toBe(false);
    expect(outOwner.refusal).toBe("insufficient_authority");
    expect(String(outOwner.detail)).toContain("owner approval");

    // Neither wrote anything.
    for (const id of [specialist, owner]) {
      expect(await physical(
        `select id from management_item_decisions where item_id = $1`, [id])).toHaveLength(0);
      expect((await physical(
        `select state from management_items where id = $1`, [id]))[0]!.state)
        .toBe("awaiting_approval");
    }
  });
});

describe.skipIf(!enabled)("decision boundary — retries and concurrency", () => {
  it("a retry with the same key and the same decision is idempotent", async () => {
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);
    const key = `retry-${itemId}`;

    const first = await decide(MANAGER, {
      itemId, decision: "approve", evidenceDigest: d, idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    expect(first.result).toBe("recorded");

    for (let i = 0; i < 3; i++) {
      const again = await decide(MANAGER, {
        itemId, decision: "approve", evidenceDigest: d, idempotencyKey: key,
      });
      expect(again.ok).toBe(true);
      expect(again.result).toBe("duplicate");
      expect(again.decision_id).toBe(first.decision_id);
    }
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(1);
  });

  it("a CONFLICTING retry under the same key is refused, not silently swallowed", async () => {
    // Returning the first decision here would hide that two different intentions were expressed
    // under one identity.
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);
    const key = `conflict-${itemId}`;

    expect((await decide(MANAGER, {
      itemId, decision: "approve", evidenceDigest: d, idempotencyKey: key,
    })).ok).toBe(true);

    const conflicting = await decide(MANAGER, {
      itemId, decision: "reject", evidenceDigest: d, idempotencyKey: key,
      reason: "changed my mind",
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.refusal).toBe("conflicting_retry");
  });

  it("SIMULTANEOUS approve/approve — exactly one wins", async () => {
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);

    const clients = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const c = new pg.Client({ connectionString: URL, ssl: false });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.all(
        clients.map((c, i) =>
          decide(i === 0 ? MANAGER : MANAGER_2, {
            itemId, decision: "approve", evidenceDigest: d,
          }, c),
        ),
      );
      expect(results.filter((r) => r.ok === true)).toHaveLength(1);
      const loser = results.find((r) => r.ok !== true)!;
      // The loser sees the winner's committed state, not a lock error.
      expect(["state_does_not_admit_decision", "stale_item"]).toContain(loser.refusal);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(1);
  });

  it("SIMULTANEOUS approve/reject — one decision, one transition, no contradiction", async () => {
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);

    const clients = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const c = new pg.Client({ connectionString: URL, ssl: false });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.allSettled([
        decide(MANAGER, { itemId, decision: "approve", evidenceDigest: d }, clients[0]!),
        decide(MANAGER_2, {
          itemId, decision: "reject", evidenceDigest: d, reason: "not needed",
        }, clients[1]!),
      ]);
      const ok = results.filter(
        (r) => r.status === "fulfilled" && (r.value as Record<string, unknown>).ok === true,
      );
      expect(ok).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    const decisions = await physical(
      `select decision from management_item_decisions where item_id=$1`, [itemId],
    );
    expect(decisions).toHaveLength(1);
    const transitions = await physical(
      `select to_state from management_item_transitions
        where item_id=$1 and to_state in ('approved','rejected')`,
      [itemId],
    );
    expect(transitions).toHaveLength(1);
    // The one decision and the one transition agree.
    expect(
      (decisions[0]!.decision === "approve" ? "approved" : "rejected"),
    ).toBe(transitions[0]!.to_state);
  });
});

describe.skipIf(!enabled)("decision boundary — the table is not writable by a session", () => {
  it("RLS is actually ON for the decision log, with no INSERT policy", async () => {
    // Asserted before the behaviour below, so a failure says WHICH of the two guarantees is
    // missing rather than only that a write got through.
    const rls = await physical<{ enabled: boolean; forced: boolean }>(
      `select relrowsecurity as enabled, relforcerowsecurity as forced
         from pg_class where oid = 'public.management_item_decisions'::regclass`,
    );
    expect(rls[0]!.enabled, "row level security must be enabled").toBe(true);

    const policies = await physical<{ cmd: string; policyname: string }>(
      `select cmd, policyname from pg_policies
        where schemaname='public' and tablename='management_item_decisions'`,
    );
    const writePolicies = policies.filter((x) => x.cmd !== "SELECT");
    expect(
      writePolicies.map((x) => `${x.cmd}:${x.policyname}`),
      "no write policy may exist — the RPC is the only way in",
    ).toEqual([]);
  });

  it("a direct INSERT by an authenticated session writes NOTHING", async () => {
    const itemId = await seedItem(CO_A);
    let threw = false;
    try {
      await asUser(
        MANAGER,
        `insert into management_item_decisions (company_id, item_id, decision, actor_id)
         values ($1,$2,'approve',$3)`,
        [CO_A, itemId, MANAGER],
      );
    } catch {
      threw = true;
    }
    // The guarantee that matters is the ABSENCE of the row, not the presence of an exception:
    // a silently-dropped write and a raised error are both acceptable refusals, and only the
    // physical read can tell an honest refusal from a successful bypass.
    const rows = await physical(
      `select decision from management_item_decisions where item_id=$1`, [itemId],
    );
    expect(rows, threw ? "refused with an error" : "refused silently").toHaveLength(0);
  });

  it("decision history cannot be updated or deleted, even by the owner of the decision", async () => {
    const itemId = await seedItem(CO_A);
    const d = await digestOf(CO_A, itemId);
    const out = await decide(MANAGER, { itemId, decision: "approve", evidenceDigest: d });
    expect(out.ok).toBe(true);

    await expect(
      q(`update management_item_decisions set decision='reject' where item_id=$1`, [itemId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      q(`delete from management_item_decisions where item_id=$1`, [itemId]),
    ).rejects.toThrow(/append-only/i);

    // And it is still there — asserted by presence, not by the absence of an error.
    const rows = await physical(
      `select decision from management_item_decisions where item_id=$1`, [itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe("approve");
  });

  it("a session cannot move item state directly, bypassing the decision", async () => {
    const itemId = await seedItem(CO_A);
    await expect(
      asUser(MANAGER, `update management_items set state='approved' where id=$1`, [itemId]),
    ).rejects.toThrow();
  });
});

describe.skipIf(!enabled)("the TypeScript digest agrees with the SQL one", () => {
  // The queue computes the evidence digest in TypeScript (to avoid a per-item round trip) and the
  // RPC recomputes it in SQL. If the two ever disagree, EVERY decision is refused with
  // `evidence_changed` and the queue becomes unusable in a way that looks like a data problem.
  // The failure is safe — it refuses rather than approves — but it is still a failure.
  it.each([
    ["one row", [["tasks", "t-1"]]],
    ["several rows, inserted out of order", [["tasks", "t-2"], ["invoices", "i-1"], ["tasks", "t-1"]]],
    // The case a naive string sort gets wrong: as tuples these order one way, as "a:b:c" strings
    // the other.
    ["a colon inside the id", [["a", "b:c"], ["a:b", "c"]]],
    ["unicode and punctuation", [["tasks", "t-é"], ["tasks", "t-|-1"]]],
    ["many rows", Array.from({ length: 25 }, (_, i) => ["tasks", `t-${25 - i}`])],
  ] as Array<[string, string[][]]>)("agrees for %s", async (_label, rows) => {
    const itemId = randomUUID();
    await q(
      `insert into management_items
         (id, company_id, department, kind, subject_table, subject_id, identity_key, state)
       values ($1,$2,'operations','overdue_task','tasks',$3,$4,'observed')`,
      [itemId, CO_A, `subj-${itemId}`, `${CO_A}:digest:${itemId}`],
    );
    for (const [table, id] of rows) {
      await q(
        `insert into management_item_evidence (company_id, item_id, source_table, source_id)
         values ($1,$2,$3,$4)`,
        [CO_A, itemId, table, id],
      );
    }

    const sql = await digestOf(CO_A, itemId);
    const ts = evidenceDigest(rows.map(([t, id]) => ({ sourceTable: t!, sourceId: id! })));
    expect(ts, `TypeScript and SQL must agree for ${_label}`).toBe(sql);
  });

  it("agrees that no evidence is `empty`", async () => {
    const itemId = randomUUID();
    await q(
      `insert into management_items
         (id, company_id, department, kind, subject_table, subject_id, identity_key, state)
       values ($1,$2,'operations','overdue_task','tasks',$3,$4,'observed')`,
      [itemId, CO_A, `subj-${itemId}`, `${CO_A}:digest-empty:${itemId}`],
    );
    expect(await digestOf(CO_A, itemId)).toBe("empty");
    expect(evidenceDigest([])).toBe("empty");
  });
});

describe.skipIf(!enabled)("decision boundary — a decision is not an execution", () => {
  it("approving produces a decision and a state, and NO business effect", async () => {
    const itemId = await seedItem(CO_A);
    const tasksBefore = (
      await physical<{ n: number }>(
        `select count(*)::int as n from tasks where company_id=$1`, [CO_A],
      )
    )[0]!.n;
    const attemptsBefore = (
      await physical<{ n: number }>(
        `select count(*)::int as n from management_execution_attempts where company_id=$1`, [CO_A],
      )
    )[0]!.n;

    const out = await decide(MANAGER, {
      itemId, decision: "approve", evidenceDigest: await digestOf(CO_A, itemId),
    });
    expect(out.ok).toBe(true);

    // Approval is a record, not an act. Execution is a separate step behind its own boundaries.
    expect(
      (await physical<{ n: number }>(
        `select count(*)::int as n from tasks where company_id=$1`, [CO_A],
      ))[0]!.n,
    ).toBe(tasksBefore);
    expect(
      (await physical<{ n: number }>(
        `select count(*)::int as n from management_execution_attempts where company_id=$1`, [CO_A],
      ))[0]!.n,
    ).toBe(attemptsBefore);
  });

  it("an action with NO handler still approves — approved-but-unavailable, zero effects", async () => {
    // `crm.followup.draft_for_human` is draft-only: the executor will refuse it. The decision is
    // still a real, recorded human decision; it simply cannot be carried out.
    const itemId = await seedItem(CO_A, { action: "crm.followup.draft_for_human" });
    const out = await decide(MANAGER, {
      itemId,
      decision: "approve",
      actionId: "crm.followup.draft_for_human",
      evidenceDigest: await digestOf(CO_A, itemId),
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);

    const items = await physical(`select state from management_items where id=$1`, [itemId]);
    expect(items[0]!.state).toBe("approved");
    expect(
      (await physical<{ n: number }>(
        `select count(*)::int as n from tasks where company_id=$1 and title like 'crm%'`, [CO_A],
      ))[0]!.n,
    ).toBe(0);
  });
});
