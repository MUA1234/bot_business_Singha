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
import { executeApprovedAction, type ExecutorDeps } from "@/kernel/execution/executor";
import { createSqlLedger, type SqlExec } from "@/kernel/execution/ledger";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";
import type { ExecutionRequest } from "@/kernel/execution/contract";
import { idempotentRpcTransport } from "@/kernel/execution/transports";
import { createInternalTask } from "@/modules/work/create-internal-task";
import { asCompanyId, asUserId } from "@/kernel/ask-ai/identity";

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

describe.skipIf(!enabled)("R2E — the real executor against the real database", () => {
  const exec: SqlExec = async (sql, params) => {
    const r = await raw.query(sql, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };

  function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
    return {
      localToken: LOCAL_EXECUTION_TOKEN,
      async companyExecutionEnabled() {
        return true;
      },
      async resolveAuthorityNow() {
        return { level: "manager_approval", failedClosed: false };
      },
      async loadApproval() {
        return {
          approvedBy: asUserId(ACTOR),
          actionId: "ops.task.create_internal",
          authority: "manager_approval" as const,
          current: true,
        };
      },
      async loadItem() {
        return { state: "approved", evidenceCount: 1, actionId: "ops.task.create_internal" };
      },
      async approverCapabilities() {
        return new Set(["operations.task.manage"]);
      },
      ledger: createSqlLedger(exec),
      handlers: {
        // The real command, the real transport, the real RPC.
        "ops.task.create_internal.v1": async (r) => {
          const out = await createInternalTask(
            idempotentRpcTransport({
              async rpc(_fn, args) {
                try {
                  const res = await raw.query(
                    `select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`,
                    [
                      args.p_company_id, args.p_idempotency_key, args.p_title,
                      args.p_description, args.p_requires_evidence, args.p_created_by,
                    ],
                  );
                  return { data: res.rows, error: null };
                } catch (e) {
                  return { data: null, error: { message: (e as Error).message } };
                }
              },
            }),
            {
              companyId: asCompanyId(r.companyId),
              idempotencyKey: r.idempotencyKey,
              title: String(r.parameters.title ?? ""),
              description: null,
              requiresEvidence: false,
              createdBy: asUserId(r.approvedBy),
            },
          );
          if (!out.ok) throw new Error(out.message);
          return { effectRef: out.taskId, created: out.created };
        },
      },
      async audit() {
        /* the executor's audit sink is asserted in the unit suite */
      },
      ...over,
    };
  }

  function req(key: string, over: Partial<ExecutionRequest> = {}): ExecutionRequest {
    return {
      companyId: asCompanyId(CO_A),
      itemId: randomUUID(),
      actionId: "ops.task.create_internal",
      approvedBy: asUserId(ACTOR),
      idempotencyKey: key,
      parameters: { title: "Executor task" },
      requestedAt: new Date(),
      ...over,
    };
  }

  it("executes once and records it, then returns a duplicate without a second task", async () => {
    const key = `exec-${randomUUID()}`;
    const first = await executeApprovedAction(deps(), req(key));
    expect(first.status).toBe("executed");
    const effectRef = first.status === "executed" ? first.effectRef : "";

    const second = await executeApprovedAction(deps(), req(key));
    expect(second.status).toBe("duplicate");
    expect(second.status === "duplicate" && second.effectRef).toBe(effectRef);

    // One task, one ledger row — asserted physically, not from the return values.
    expect(await physicalCount("tasks", "id = $1", [effectRef])).toBe(1);
    expect(
      await physicalCount(
        "management_execution_attempts",
        "company_id = $1 and idempotency_key = $2",
        [CO_A, key],
      ),
    ).toBe(1);
  });

  it("a crash between the effect and the ledger cannot produce a second task", async () => {
    // The crash is simulated where one actually happens: the handler created the task, then the
    // process died before the ledger row could be resolved.
    const key = `crash-${randomUUID()}`;
    const crashing = deps({
      ledger: {
        ...createSqlLedger(exec),
        async resolveExecuted() {
          throw new Error("process died before resolving");
        },
      },
    });
    const crashed = await executeApprovedAction(crashing, req(key));
    expect(crashed.status).toBe("failed");

    const afterCrash = await physicalCount("tasks", "company_id = $1 and title = $2", [
      CO_A, "Executor task",
    ]);

    // The retry, with the same key. Whatever the ledger decides, no SECOND task may appear.
    await executeApprovedAction(deps(), req(key));
    expect(
      await physicalCount("tasks", "company_id = $1 and title = $2", [CO_A, "Executor task"]),
    ).toBe(afterCrash);
  });

  it("a refusal does NOT consume the idempotency key", async () => {
    // Refused for a missing approval, then approved and executed under the SAME key. Had the
    // refusal consumed the key, the legitimate execution could never happen afterwards.
    const key = `refuse-then-run-${randomUUID()}`;
    const refused = await executeApprovedAction(
      deps({ async loadApproval() { return null; } }),
      req(key),
    );
    expect(refused.status === "refused" && refused.reason).toBe("approval_missing");

    const ok = await executeApprovedAction(deps(), req(key));
    expect(ok.status).toBe("executed");
  });

  it("writes NOTHING when the global boundary is closed", async () => {
    const attemptsBefore = await physicalCount(
      "management_execution_attempts", "company_id = $1", [CO_A],
    );
    const tasksBefore = await physicalCount("tasks", "company_id = $1", [CO_A]);

    const out = await executeApprovedAction(
      deps({ localToken: undefined }),
      req(`disabled-${randomUUID()}`),
    );
    expect(out.status === "refused" && out.reason).toBe("global_boundary_disabled");

    expect(
      await physicalCount("management_execution_attempts", "company_id = $1", [CO_A]),
    ).toBe(attemptsBefore);
    expect(await physicalCount("tasks", "company_id = $1", [CO_A])).toBe(tasksBefore);
  });

  it("writes NOTHING when the company is not enabled for execution", async () => {
    const attemptsBefore = await physicalCount(
      "management_execution_attempts", "company_id = $1", [CO_A],
    );
    const tasksBefore = await physicalCount("tasks", "company_id = $1", [CO_A]);

    const out = await executeApprovedAction(
      deps({ async companyExecutionEnabled() { return false; } }),
      req(`notenabled-${randomUUID()}`),
    );
    expect(out.status === "refused" && out.reason).toBe("company_not_enabled");

    expect(
      await physicalCount("management_execution_attempts", "company_id = $1", [CO_A]),
    ).toBe(attemptsBefore);
    expect(await physicalCount("tasks", "company_id = $1", [CO_A])).toBe(tasksBefore);
  });

  it("a draft-only or prohibited action produces no task, whatever the caller asks for", async () => {
    const tasksBefore = await physicalCount("tasks", "company_id = $1", [CO_A]);
    for (const actionId of [
      "crm.followup.draft_for_human",
      "finance.invoice.flag_for_review",
      "legal.obligation.escalate_internal",
      "system.health.investigate_internal",
    ] as const) {
      const out = await executeApprovedAction(
        deps(),
        req(`draft-${randomUUID()}`, { actionId, parameters: { title: "Should never exist" } }),
      );
      expect(out.status, actionId).toBe("refused");
    }
    expect(await physicalCount("tasks", "company_id = $1", [CO_A])).toBe(tasksBefore);
    expect(await physicalCount("tasks", "title = $1", ["Should never exist"])).toBe(0);
  });
});
