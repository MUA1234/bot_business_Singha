/**
 * R2E — the execution ledger and the one allowlisted handler, against a real PostgreSQL.
 *
 * The unit suite proves the executor's DECISIONS. It cannot prove the properties that only a real
 * database has: that a unique index actually arbitrates two concurrent claims, that an append-only
 * trigger actually refuses, that RLS actually stops an authenticated session writing an execution
 * record, and that a crashed attempt leaves a resumable row rather than a duplicate task.
 *
 * Every assertion about storage reads through a PRIVILEGED connection with RLS out of the way.
 * R2D-F-006 is why: a policy that hides a row makes "deleted" and "hidden" indistinguishable, and
 * a test that stops at the ordinary read reports the wrong one.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  executeManagementAction,
  buildExecutorDeps,
  type ExecutionEnvironment,
} from "@/kernel/execution/service";
import { executeApprovedAction } from "@/kernel/execution/executor";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";
import type { SqlExec } from "@/kernel/execution/ledger";
import { asCompanyId } from "@/kernel/ask-ai/identity";
import type { CatalogueActionId } from "@/kernel/catalogue";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const ACTOR = randomUUID();

let raw: pg.Client;
const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** Count with RLS explicitly bypassed: "is it there", never "can I see it". */
async function physicalCount(table: string, where: string, params: unknown[]): Promise<number> {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(`select count(*)::int as n from ${table} where ${where}`, params);
    return rows[0].n as number;
  } finally {
    await q("commit");
  }
}

beforeAll(async () => {
  if (!enabled) return;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  for (const c of [CO_A, CO_B]) {
    await q(
      `insert into companies (id, name, base_currency) values ($1, $2, 'LKR')
         on conflict (id) do nothing`,
      [c, `R2E ${c.slice(0, 8)}`],
    );
  }
  // A real person with a real, ACTIVE membership. The kernel's atomic create RPC refuses an actor
  // who is not an active member, which is the product working — so the fixture provides one rather
  // than a bare uuid.
  await q(
    `insert into users (id, email, full_name) values ($1, $2, 'R2E Actor')
       on conflict (id) do nothing`,
    [ACTOR, `r2e-${ACTOR.slice(0, 8)}@example.invalid`],
  );
  for (const c of [CO_A, CO_B]) {
    await q(
      `insert into memberships (company_id, user_id, status) values ($1, $2, 'active')
         on conflict (company_id, user_id) do nothing`,
      [c, ACTOR],
    );
  }
});

afterAll(async () => {
  if (!enabled) return;
  await raw?.end();
});

describe.skipIf(!enabled)("R2E — the atomic task handler is exactly-once", () => {
  it("creates exactly one task for one idempotency key, however many callers race", async () => {
    const key = `race-${randomUUID()}`;

    // Ten concurrent callers, each on its OWN connection — concurrency on a single client is
    // serialised by the driver and would prove nothing about the database's arbitration.
    const clients = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const c = new pg.Client({ connectionString: URL, ssl: false });
        await c.connect();
        return c;
      }),
    );

    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query(
            `select * from r1_draft_create_internal_task($1, $2, $3, $4, $5, $6)`,
            [CO_A, key, "Racing task", null, false, ACTOR],
          ),
        ),
      );

      const ids = new Set(results.map((r) => r.rows[0].task_id as string));
      const createdFlags = results.map((r) => r.rows[0].created as boolean);

      // One task id, agreed by all ten.
      expect(ids.size, "distinct task ids returned").toBe(1);
      // Exactly one caller was told it created it.
      expect(createdFlags.filter(Boolean).length, "callers reporting created=true").toBe(1);

      // And the database holds exactly one task, verified by content rather than by trusting
      // the return values — a row COUNT survives an insert-then-delete, but this is a fresh key.
      const taskId = [...ids][0];
      expect(await physicalCount("tasks", "id = $1", [taskId])).toBe(1);
      expect(await physicalCount("tasks", "company_id = $1 and title = $2", [CO_A, "Racing task"]))
        .toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("a replay returns the first task and creates nothing", async () => {
    const key = `replay-${randomUUID()}`;
    const first = await q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
      CO_A, key, "Replayed task", null, false, ACTOR,
    ]);
    expect(first.rows[0].created).toBe(true);

    for (let i = 0; i < 3; i++) {
      const again = await q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
        CO_A, key, "Replayed task", null, false, ACTOR,
      ]);
      expect(again.rows[0].created).toBe(false);
      expect(again.rows[0].task_id).toBe(first.rows[0].task_id);
    }

    expect(await physicalCount("tasks", "company_id = $1 and title = $2", [CO_A, "Replayed task"]))
      .toBe(1);
  });

  it("the SAME key in a different company is a different task — keys are company-scoped", async () => {
    const key = `shared-${randomUUID()}`;
    const a = await q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
      CO_A, key, "Scoped task", null, false, ACTOR,
    ]);
    const b = await q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
      CO_B, key, "Scoped task", null, false, ACTOR,
    ]);
    expect(a.rows[0].created).toBe(true);
    expect(b.rows[0].created).toBe(true);
    expect(a.rows[0].task_id).not.toBe(b.rows[0].task_id);
  });

  it("creates the task UNASSIGNED — assignment is a separate authority", async () => {
    const key = `unassigned-${randomUUID()}`;
    const r = await q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
      CO_A, key, "Unassigned task", null, false, ACTOR,
    ]);
    await q("begin");
    try {
      await q("set local role postgres");
      const { rows } = await q(`select assigned_to, status from tasks where id = $1`, [
        r.rows[0].task_id,
      ]);
      expect(rows[0].assigned_to).toBeNull();
      expect(rows[0].status).toBe("captured");
    } finally {
      await q("commit");
    }
  });

  it("refuses a blank title and a blank key rather than creating something meaningless", async () => {
    await expect(
      q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
        CO_A, `blank-${randomUUID()}`, "   ", null, false, ACTOR,
      ]),
    ).rejects.toThrow(/title is required/);

    await expect(
      q(`select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`, [
        CO_A, "  ", "Has a title", null, false, ACTOR,
      ]),
    ).rejects.toThrow(/idempotency_key is required/);
  });
});

describe.skipIf(!enabled)("R2E — the ledger is append-only and honest", () => {
  async function claim(companyId: string, key: string): Promise<string> {
    const { rows } = await q(
      `insert into management_execution_attempts
         (company_id, item_id, action_id, idempotency_key, status, handler)
       values ($1, $2, 'ops.task.create_internal', $3, 'attempting', 'ops.task.create_internal.v1')
       returning id`,
      [companyId, randomUUID(), key],
    );
    return rows[0].id as string;
  }

  it("refuses a second claim on the same (company, key)", async () => {
    const key = `dup-${randomUUID()}`;
    await claim(CO_A, key);
    await expect(claim(CO_A, key)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("resolves attempting → executed once, then refuses any further change", async () => {
    const id = await claim(CO_A, `resolve-${randomUUID()}`);
    await q(
      `update management_execution_attempts
          set status = 'executed', effect_ref = $2, completed_at = now()
        where id = $1`,
      [id, "task-xyz"],
    );

    // Terminal is terminal: not re-openable, not re-writable, not deletable.
    await expect(
      q(`update management_execution_attempts set status = 'failed', detail = 'x' where id = $1`, [id]),
    ).rejects.toThrow(/already terminal/);
    await expect(
      q(`update management_execution_attempts set effect_ref = 'task-other' where id = $1`, [id]),
    ).rejects.toThrow(/already terminal/);
    await expect(
      q(`delete from management_execution_attempts where id = $1`, [id]),
    ).rejects.toThrow(/append-only/);

    // And the delete really did not happen — asserted by presence, not by the absence of an error.
    expect(await physicalCount("management_execution_attempts", "id = $1", [id])).toBe(1);
  });

  it("refuses to rewrite an attempt's identity", async () => {
    const id = await claim(CO_A, `identity-${randomUUID()}`);
    await expect(
      q(`update management_execution_attempts set company_id = $2, status='failed', completed_at=now() where id = $1`, [id, CO_B]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      q(`update management_execution_attempts set action_id = 'legal.obligation.escalate_internal', status='failed', completed_at=now() where id = $1`, [id]),
    ).rejects.toThrow(/identity is immutable/);
  });

  it("refuses a terminal row that does not say what happened", async () => {
    const id = await claim(CO_A, `shape-${randomUUID()}`);
    // 'executed' with no effect_ref is a success claim with nothing behind it.
    await expect(
      q(`update management_execution_attempts set status='executed', completed_at=now() where id=$1`, [id]),
    ).rejects.toThrow(/execution_attempt_terminal_shape/);
    // 'refused' with no reason is a refusal nobody can explain later.
    await expect(
      q(`update management_execution_attempts set status='refused', completed_at=now() where id=$1`, [id]),
    ).rejects.toThrow(/execution_attempt_terminal_shape/);
  });

  it("refuses to leave a resolved row still 'attempting'", async () => {
    const id = await claim(CO_A, `stuck-${randomUUID()}`);
    await expect(
      q(`update management_execution_attempts set detail = 'touched' where id = $1`, [id]),
    ).rejects.toThrow(/must resolve to a terminal status/);
  });
});

describe.skipIf(!enabled)("R2E — execution enablement defaults to disabled", () => {
  it("a company with no row is not enabled, and a row defaults to false", async () => {
    const { rows: none } = await q(
      `select enabled from management_execution_enablement where company_id = $1`,
      [CO_A],
    );
    expect(none.length).toBe(0); // absence IS the disabled state

    await q(`insert into management_execution_enablement (company_id) values ($1)`, [CO_A]);
    const { rows } = await q(
      `select enabled from management_execution_enablement where company_id = $1`,
      [CO_A],
    );
    expect(rows[0].enabled).toBe(false);
  });

  it("kernel enablement does NOT imply execution enablement", async () => {
    // The two switches are separate tables. Enabling observation must not confer the power to act.
    await q(
      `insert into management_kernel_enablement (company_id, enabled) values ($1, true)
       on conflict (company_id) do update set enabled = true`,
      [CO_B],
    );
    const { rows } = await q(
      `select enabled from management_execution_enablement where company_id = $1`,
      [CO_B],
    );
    expect(rows.length === 0 || rows[0].enabled === false).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The REAL server execution service, against real seeded management state.
//
// Everything below goes through `executeManagementAction`, which reads the item, the decision, the
// evidence and the capability join from the database itself. No loader is stubbed: a stubbed loader
// would prove the executor's arithmetic and nothing about whether the queries behind it are right.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("R2E — the real server execution service", () => {
  const sql: SqlExec = async (text, params) => {
    const r = await raw.query(text, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };

  /** The service's RPC surface, over the same disposable database. */
  const rpc = {
    async rpc(_fn: string, args: Record<string, unknown>) {
      try {
        const r = await raw.query(
          `select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`,
          [
            args.p_company_id, args.p_idempotency_key, args.p_title,
            args.p_description, args.p_requires_evidence, args.p_created_by,
          ],
        );
        return { data: r.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };

  const audits: { action: string; actorId: unknown }[] = [];
  const env = (over: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment => ({
    sql,
    rpc,
    async audit(e) {
      audits.push({ action: e.action, actorId: e.actorId });
    },
    localToken: LOCAL_EXECUTION_TOKEN,
    ...over,
  });

  /**
   * Seed one complete, executable management item: the item itself, its evidence, and the
   * recommendation snapshot whose `evidence_refs` establish the generation the recommendation was
   * computed from.
   */
  async function seedItem(
    companyId: string,
    opts: { state?: string; action?: string; evidence?: [string, string][] } = {},
  ): Promise<string> {
    const itemId = randomUUID();
    const evidence = opts.evidence ?? [["tasks", `t-${randomUUID()}`]];
    await q(
      // `proposed_action_id`, which is the column the kernel's own atomic create RPC writes.
      // `proposed_action` also exists (draft 001) and is written by NOTHING — see R2E-F-010 and
      // the test below that seeds through the real RPC so this choice cannot be assumed again.
      `insert into management_items
         (id, company_id, department, kind, subject_table, subject_id, identity_key,
          state, proposed_action_id)
       values ($1, $2, 'operations', 'overdue_task', 'tasks', $3, $4, $5, $6)`,
      [
        itemId, companyId, evidence[0]![1], `${companyId}:overdue:${itemId}`,
        opts.state ?? "approved", opts.action ?? "ops.task.create_internal",
      ],
    );
    for (const [table, id] of evidence) {
      await q(
        `insert into management_item_evidence (company_id, item_id, source_table, source_id)
         values ($1, $2, $3, $4)`,
        [companyId, itemId, table, id],
      );
    }
    await q(
      `insert into management_item_recommendations
         (company_id, item_id, purpose, outcome, candidate_ref, candidate_type, rank_position,
          resolver_version, signal_rule_version, fingerprint, evidence_refs)
       values ($1, $2, 'assignee', 'candidates', $3, 'staff', 1,
               'r2e-test', 'r2e-test', $4, $5::jsonb)`,
      [
        companyId, itemId, ACTOR, `fp-${itemId}`,
        JSON.stringify(evidence.map(([t, id]) => ({ sourceTable: t, sourceId: id }))),
      ],
    );
    return itemId;
  }

  async function enableExecution(companyId: string, enabled_: boolean): Promise<void> {
    await q(
      `insert into management_execution_enablement (company_id, enabled)
       values ($1, $2)
       on conflict (company_id) do update set enabled = excluded.enabled`,
      [companyId, enabled_],
    );
  }

  beforeAll(async () => {
    if (!enabled) return;
    await enableExecution(CO_A, true);
    await enableExecution(CO_B, true);
  });

  it("executes the authorised automatic action end to end, through the real loaders", async () => {
    const itemId = await seedItem(CO_A);
    const out = await executeManagementAction(env(), {
      companyId: CO_A,
      itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Service-created task" },
    });

    expect(out.status, JSON.stringify(out)).toBe("executed");
    const effectRef = out.status === "executed" ? out.effectRef : "";

    // The task exists, is company-scoped, and is UNASSIGNED.
    await q("begin");
    try {
      await q("set local role postgres");
      const { rows } = await q(
        `select company_id, assigned_to, status, title from tasks where id = $1`,
        [effectRef],
      );
      expect(rows[0].company_id).toBe(CO_A);
      expect(rows[0].assigned_to).toBeNull();
      expect(rows[0].status).toBe("captured");
      expect(rows[0].title).toBe("Service-created task");
    } finally {
      await q("commit");
    }

    // Exactly one ledger row, terminal, naming the effect.
    await q("begin");
    try {
      await q("set local role postgres");
      const { rows } = await q(
        `select status, effect_ref, resolved_authority, approved_by
           from management_execution_attempts
          where company_id = $1 and item_id = $2 and status <> 'refused'`,
        [CO_A, itemId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("executed");
      expect(rows[0].effect_ref).toBe(effectRef);
      expect(rows[0].resolved_authority).toBe("automatic");
      // No approver: it ran automatically, and the ledger says so rather than naming a person.
      expect(rows[0].approved_by).toBeNull();
    } finally {
      await q("commit");
    }
  });

  it("a retry after an uncertain outcome returns the same task, not a second one", async () => {
    const itemId = await seedItem(CO_A);
    const input = {
      companyId: CO_A,
      itemId,
      actionId: "ops.task.create_internal" as CatalogueActionId,
      parameters: { title: "Retried task" },
    };
    const first = await executeManagementAction(env(), input);
    expect(first.status).toBe("executed");

    for (let i = 0; i < 3; i++) {
      const again = await executeManagementAction(env(), input);
      expect(again.status).toBe("duplicate");
      expect(again.status === "duplicate" && again.effectRef).toBe(
        first.status === "executed" ? first.effectRef : "",
      );
    }
    expect(await physicalCount("tasks", "company_id = $1 and title = $2", [CO_A, "Retried task"]))
      .toBe(1);
  });

  it("survives a crash after the effect but before the ledger resolves", async () => {
    const itemId = await seedItem(CO_A);
    const deps = buildExecutorDeps(env());
    const crashing = {
      ...deps,
      ledger: {
        ...deps.ledger,
        async resolveExecuted() {
          throw new Error("process died before resolving");
        },
      },
    };
    const req = {
      companyId: asCompanyId(CO_A),
      itemId,
      actionId: "ops.task.create_internal" as CatalogueActionId,
      approvedBy: null,
      parameters: { title: "Crashed task" },
      requestedAt: new Date(),
    };
    const crashed = await executeApprovedAction(crashing, req);
    expect(crashed.status).toBe("failed");

    const afterCrash = await physicalCount(
      "tasks", "company_id = $1 and title = $2", [CO_A, "Crashed task"],
    );

    // The retry, through the real service. No SECOND task may appear.
    await executeManagementAction(env(), {
      companyId: CO_A, itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Crashed task" },
    });
    expect(
      await physicalCount("tasks", "company_id = $1 and title = $2", [CO_A, "Crashed task"]),
    ).toBe(afterCrash);
  });

  it("refuses when the evidence generation moved on, and creates nothing", async () => {
    // R2E-F-006, against the real digest: the count is unchanged, the CONTENT is not.
    const itemId = await seedItem(CO_A, { evidence: [["tasks", "ev-original"]] });
    // `management_item_evidence` is append-only — the product refuses an UPDATE, which is correct
    // and is why the generation changes by ACCRETION: a detector observes something new after the
    // recommendation was computed.
    await q(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id)
       values ($1, $2, 'tasks', 'ev-appeared-later')`,
      [CO_A, itemId],
    );

    const before = await physicalCount("tasks", "company_id = $1", [CO_A]);
    const out = await executeManagementAction(env(), {
      companyId: CO_A, itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Stale evidence task" },
    });
    expect(out.status === "refused" && out.reason).toBe("evidence_stale");
    expect(await physicalCount("tasks", "company_id = $1", [CO_A])).toBe(before);
  });

  it("refuses an item in a state that does not admit execution", async () => {
    // Terminal states are excluded deliberately: `management_items_outcome_ck` requires an
    // outcome for them, so seeding one would be seeding a contradiction rather than a test.
    for (const state of ["observed", "understood", "prioritised", "recommended", "awaiting_approval"]) {
      const itemId = await seedItem(CO_A, { state });
      const out = await executeManagementAction(env(), {
        companyId: CO_A, itemId,
        actionId: "ops.task.create_internal",
        parameters: { title: `State ${state}` },
      });
      expect(out.status === "refused" && out.reason, state).toBe("item_state_invalid");
      expect(await physicalCount("tasks", "title = $1", [`State ${state}`])).toBe(0);
    }
  });

  it("refuses when the item proposes a different action than the one requested", async () => {
    const itemId = await seedItem(CO_A, { action: "ops.task.escalate_internal" });
    const out = await executeManagementAction(env(), {
      companyId: CO_A, itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Mismatched action" },
    });
    expect(out.status === "refused" && out.reason).toBe("stale_state");
    expect(await physicalCount("tasks", "title = $1", ["Mismatched action"])).toBe(0);
  });

  it("TENANT ISOLATION — company B cannot execute company A's item", async () => {
    const itemId = await seedItem(CO_A);
    const out = await executeManagementAction(env(), {
      companyId: CO_B,
      itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Cross-tenant task" },
    });
    // The item is not visible under B's scope at all, so it reads as absent rather than forbidden.
    expect(out.status === "refused" && out.reason).toBe("item_state_invalid");
    expect(await physicalCount("tasks", "title = $1", ["Cross-tenant task"])).toBe(0);
  });

  it("refuses malformed parameters, and an unknown key, before touching the database", async () => {
    const itemId = await seedItem(CO_A);
    for (const params of [
      { title: "" },
      { title: "ok", assignedTo: ACTOR },
      { title: "ok", requiresEvidence: "yes" },
      {},
    ]) {
      const out = await executeManagementAction(env(), {
        companyId: CO_A, itemId,
        actionId: "ops.task.create_internal",
        parameters: params,
      });
      expect(out.status === "refused" && out.reason, JSON.stringify(params)).toBe(
        "parameters_invalid",
      );
    }
    expect(await physicalCount("tasks", "company_id = $1 and title = $2", [CO_A, "ok"])).toBe(0);
  });

  it("writes NOTHING when the global boundary is closed", async () => {
    const itemId = await seedItem(CO_A);
    const attemptsBefore = await physicalCount(
      "management_execution_attempts", "company_id = $1", [CO_A],
    );
    const tasksBefore = await physicalCount("tasks", "company_id = $1", [CO_A]);

    const out = await executeManagementAction(env({ localToken: undefined }), {
      companyId: CO_A, itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Disabled task" },
    });
    expect(out.status === "refused" && out.reason).toBe("global_boundary_disabled");

    expect(
      await physicalCount("management_execution_attempts", "company_id = $1", [CO_A]),
    ).toBe(attemptsBefore);
    expect(await physicalCount("tasks", "company_id = $1", [CO_A])).toBe(tasksBefore);
  });

  it("writes NOTHING when the company execution setting is off", async () => {
    const itemId = await seedItem(CO_B);
    await enableExecution(CO_B, false);
    try {
      const attemptsBefore = await physicalCount(
        "management_execution_attempts", "company_id = $1", [CO_B],
      );
      const tasksBefore = await physicalCount("tasks", "company_id = $1", [CO_B]);

      const out = await executeManagementAction(env(), {
        companyId: CO_B, itemId,
        actionId: "ops.task.create_internal",
        parameters: { title: "Company disabled task" },
      });
      expect(out.status === "refused" && out.reason).toBe("company_not_enabled");

      expect(
        await physicalCount("management_execution_attempts", "company_id = $1", [CO_B]),
      ).toBe(attemptsBefore);
      expect(await physicalCount("tasks", "company_id = $1", [CO_B])).toBe(tasksBefore);
    } finally {
      await enableExecution(CO_B, true);
    }
  });

  it("KERNEL enablement alone does not permit execution", async () => {
    // The two switches are separate rows in separate tables, and this is the case that would
    // regress if anything ever read one for the other.
    const itemId = await seedItem(CO_B);
    await q(
      `insert into management_kernel_enablement (company_id, enabled) values ($1, true)
       on conflict (company_id) do update set enabled = true`,
      [CO_B],
    );
    await enableExecution(CO_B, false);
    try {
      const out = await executeManagementAction(env(), {
        companyId: CO_B, itemId,
        actionId: "ops.task.create_internal",
        parameters: { title: "Kernel-only task" },
      });
      expect(out.status === "refused" && out.reason).toBe("company_not_enabled");
      expect(await physicalCount("tasks", "title = $1", ["Kernel-only task"])).toBe(0);
    } finally {
      await enableExecution(CO_B, true);
    }
  });

  it("every draft-only and prohibited action produces nothing, through the real service", async () => {
    const tasksBefore = await physicalCount("tasks", "company_id = $1", [CO_A]);
    for (const actionId of [
      "ops.task.reminder_internal",
      "ops.task.escalate_internal",
      "finance.invoice.flag_for_review",
      "crm.followup.draft_for_human",
      "legal.obligation.escalate_internal",
      "system.health.investigate_internal",
    ] as const) {
      const itemId = await seedItem(CO_A, { action: actionId });
      const out = await executeManagementAction(env(), {
        companyId: CO_A, itemId, actionId,
        parameters: { title: "Should never exist" },
      });
      expect(out.status, actionId).toBe("refused");
      expect(
        out.status === "refused" &&
          ["classification_draft_only", "classification_prohibited"].includes(out.reason),
        `${actionId} → ${out.status === "refused" ? out.reason : out.status}`,
      ).toBe(true);
    }
    expect(await physicalCount("tasks", "company_id = $1", [CO_A])).toBe(tasksBefore);
    expect(await physicalCount("tasks", "title = $1", ["Should never exist"])).toBe(0);
  });

  it("reads the proposed action from an item the KERNEL created, not one a test shaped", async () => {
    // R2E-F-010. `management_items` carries TWO columns for the proposed action —
    // `proposed_action` (draft 001) and `proposed_action_id` (draft 009). Only the second is ever
    // written: the kernel's atomic create RPC populates it and nothing populates the first.
    //
    // The executor originally read `proposed_action`, so every real item looked actionless and
    // every real execution would have refused with `stale_state`. The seeding tests did not catch
    // it because they wrote the same wrong column the reader read — a closed loop that agreed with
    // itself. This one creates the item through the REAL RPC, so the column choice is proven by
    // the product rather than by the fixture.
    // The RPC is a SERVICE-ONLY boundary — an authenticated session is refused, which is the
    // product working. The real executor runs server-side, so the test adopts that role for the
    // seeding call and drops it again immediately.
    let itemId = "";
    await q("begin");
    try {
      // The guard reads the JWT ROLE CLAIM, not the database role — an EXECUTE grant alone is
      // not a trust boundary, which is the point of that design.
      await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const { rows } = await q(
        `select public.r1_draft_create_management_item(
           $1, $2, 'operations', 'overdue_task', 'operations.task_exception', 'tasks', $3, $4, $5,
           'high', 0.9, 'automatic', 'ops.task.create_internal', 'sufficient',
           false, null, null, $6::jsonb) as id`,
        [
          CO_A, ACTOR, `subj-${randomUUID()}`, `${CO_A}:kernel:${randomUUID()}`,
          `corr-${randomUUID()}`,
          JSON.stringify([{ source_table: "tasks", source_id: `ev-${randomUUID()}` }]),
        ],
      );
      // The RPC returns a jsonb envelope, not a bare id.
      itemId = String((rows[0].id as { item_id: string }).item_id);
    } finally {
      await q("commit");
    }

    const deps = buildExecutorDeps(env());
    const snapshot = await deps.loadItem({
      companyId: asCompanyId(CO_A),
      itemId,
      actionId: "ops.task.create_internal",
      approvedBy: null,
      parameters: {},
      requestedAt: new Date(),
    });

    // The whole point: the executor sees the action the kernel actually recorded.
    expect(snapshot).not.toBeNull();
    expect(snapshot!.actionId).toBe("ops.task.create_internal");
    expect(snapshot!.evidenceCount).toBeGreaterThan(0);
    // The RPC enforces the initial state, so this item is not yet executable — which is correct,
    // and is asserted so the test cannot be misread as "the kernel creates executable items".
    expect(snapshot!.state).toBe("observed");
  });

  it("a refusal does not consume the execution identity", async () => {
    // Refused because the item is in the wrong state; corrected; then executed. Had the refusal
    // claimed the derived identity, the legitimate execution could never happen.
    const itemId = await seedItem(CO_A, { state: "awaiting_approval" });
    const first = await executeManagementAction(env(), {
      companyId: CO_A, itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Refused then run" },
    });
    expect(first.status === "refused" && first.reason).toBe("item_state_invalid");

    // The state may only move through `r1_draft_transition_item()` — a direct UPDATE is refused
    // by the transition boundary, which is the product working. So the correction goes through the
    // real lifecycle, as it would in production.
    await q(
      `select r1_draft_transition_item($1, 'awaiting_approval', 'approved', $2, 'user', 'approved for test')`,
      [itemId, ACTOR],
    );
    const second = await executeManagementAction(env(), {
      companyId: CO_A, itemId,
      actionId: "ops.task.create_internal",
      parameters: { title: "Refused then run" },
    });
    expect(second.status).toBe("executed");
  });
});

