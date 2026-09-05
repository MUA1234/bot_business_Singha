/**
 * Outcome verification by re-observation, through the REAL runtime path (roadmap R5, R2F-F-004).
 *
 * The unit suite proves the decision. This proves the path: the item and its originating record are
 * loaded from the database, the re-read is targeted at the exact record the item names, and the
 * lifecycle moves through `r1_draft_transition_item()` — the same boundary every other writer uses.
 *
 * The rule that matters throughout: **creating a task proves only that a task was created.** The
 * originating condition is a different fact, and only a fresh read of the originating record can
 * settle it.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { verifyManagementOutcome } from "@/kernel/verification/service";
import type { SqlExec } from "@/kernel/execution/ledger";
import type { SweepState } from "@/kernel/verification/contract";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const ACTOR = randomUUID();
/** `verifying` and `monitoring` demand an accountable owner, so the fixture supplies a real one. */
const membershipOf = new Map<string, string>();

let raw: pg.Client;
const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const sql: SqlExec = async (text, params) => {
  const r = await raw.query(text, params as unknown[]);
  return { rows: r.rows as Record<string, unknown>[] };
};

const NOW = () => new Date();
const cleanSweep = (): SweepState => ({
  complete: true,
  generation: "gen-live",
  interrupted: false,
  // Later than any claim seeded below.
  observedAt: new Date(Date.now() + 60_000),
});

async function seedTask(
  company: string,
  opts: { status?: string; dueDate?: string | null; requiresEvidence?: boolean } = {},
): Promise<string> {
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, requires_evidence)
     values ($1,'Chase the delivery',$2,$3::date,$4) returning id`,
    [company, opts.status ?? "in_progress", opts.dueDate ?? "2020-01-01",
     opts.requiresEvidence ?? false],
  );
  return String(rows[0].id);
}

/**
 * An item in `verifying`, with a recorded claim moment.
 *
 * The state is set directly and the transition row written explicitly: the lifecycle boundary
 * would require walking every intermediate state, which is not what this file is testing.
 */
async function seedItem(
  company: string,
  taskId: string,
  opts: { kind?: string; department?: string; state?: string } = {},
): Promise<string> {
  const itemId = randomUUID();
  await q(
    `insert into management_items
       (id, company_id, department, kind, subject_table, subject_id, identity_key, state,
        accountable_owner_id)
     values ($1,$2,$3,$4,'tasks',$5,$6,$7,$8)`,
    [itemId, company, opts.department ?? "operations", opts.kind ?? "overdue",
     taskId, `${company}:ver:${itemId}`, opts.state ?? "verifying",
     membershipOf.get(company)!],
  );
  await q(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id)
     values ($1,$2,'tasks',$3)`,
    [company, itemId, taskId],
  );
  await q(
    `insert into management_item_transitions
       (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, created_at)
     values ($1,$2,'monitoring',$3,$4,'user','claimed complete', now() - interval '1 hour')`,
    [company, itemId, opts.state ?? "verifying", ACTOR],
  );
  return itemId;
}

async function stateOf(itemId: string): Promise<string> {
  const { rows } = await q(`select state from management_items where id = $1`, [itemId]);
  return String(rows[0]?.state ?? "(gone)");
}

beforeAll(async () => {
  if (!enabled) return;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  for (const c of [CO_A, CO_B]) {
    await q(
      `insert into companies (id, name, base_currency) values ($1,$2,'LKR')
         on conflict (id) do nothing`,
      [c, `VER ${c.slice(0, 8)}`],
    );
  }
  await q(
    `insert into users (id, email, full_name) values ($1,$2,'Verification actor')
       on conflict (id) do nothing`,
    [ACTOR, `ver-${ACTOR.slice(0, 8)}@example.invalid`],
  );
  for (const c of [CO_A, CO_B]) {
    const { rows } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
         on conflict (company_id, user_id) do update set status='active' returning id`,
      [c, ACTOR],
    );
    membershipOf.set(c, String(rows[0].id));
  }
});

afterAll(async () => {
  if (!enabled) return;
  await raw?.end();
});

const env = { sql, now: NOW };
const run = (itemId: string, sweep = cleanSweep()) =>
  verifyManagementOutcome(env, { companyId: CO_A, itemId, actorId: ACTOR, sweep });

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("a genuine resolution, end to end", () => {
  it("verifies and MOVES the lifecycle when the originating task is completed", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId);
    expect(out.outcome, JSON.stringify(out)).toBe("verified_resolved");
    expect(out.transitioned).toBe(true);
    expect(await stateOf(itemId)).toBe("verified");
  });

  it("verifies when the condition itself is gone — the due date moved out", async () => {
    const taskId = await seedTask(CO_A, { status: "in_progress", dueDate: "2030-01-01" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId);
    expect(out.outcome).toBe("verified_resolved");
    expect(await stateOf(itemId)).toBe("verified");
  });
});

describe.skipIf(!enabled)("a claim is not a verification", () => {
  it("REOPENS when the task is still live and still overdue", async () => {
    const taskId = await seedTask(CO_A, { status: "in_progress", dueDate: "2020-01-01" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId);
    expect(out.outcome).toBe("condition_persists");
    expect(out.transitioned).toBe(true);
    expect(await stateOf(itemId)).toBe("reopened");
  });

  it("CONTRADICTS a task closed complete that required evidence and has none verified", async () => {
    const taskId = await seedTask(CO_A, { status: "completed", requiresEvidence: true });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId);
    expect(out.outcome).toBe("contradicted");
    expect(await stateOf(itemId)).toBe("reopened");
  });

  it("accepts the same task once its evidence is actually VERIFIED by someone", async () => {
    const taskId = await seedTask(CO_A, { status: "completed", requiresEvidence: true });
    await q(
      `insert into task_evidence (task_id, company_id, kind, reference, verified_by)
       values ($1,$2,'document','ref-1',$3)`,
      [taskId, CO_A, ACTOR],
    );
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId);
    expect(out.outcome).toBe("verified_resolved");
    expect(await stateOf(itemId)).toBe("verified");
  });
});

describe.skipIf(!enabled)("execution is not outcome", () => {
  it("a created internal task does NOT verify the condition that prompted it", async () => {
    // The action creates a NEW task. The originating task is untouched and still overdue.
    const originating = await seedTask(CO_A, { status: "in_progress", dueDate: "2020-01-01" });
    const itemId = await seedItem(CO_A, originating);

    const created = await q(
      `select * from r1_draft_create_internal_task($1,$2,$3,null,false,$4)`,
      [CO_A, `verify-${itemId}`, "Chase it up", ACTOR],
    );
    expect(created.rows[0].created).toBe(true);

    // The effect exists …
    const { rows: effect } = await q(
      `select status, assigned_to from tasks where id = $1`, [created.rows[0].task_id],
    );
    expect(effect[0].status).toBe("captured");
    expect(effect[0].assigned_to).toBeNull();

    // … and the business outcome is separately, independently, NOT resolved.
    const out = await run(itemId);
    expect(out.outcome).toBe("condition_persists");
    expect(await stateOf(itemId)).toBe("reopened");
  });
});

describe.skipIf(!enabled)("absence, failure and ambiguity", () => {
  it("a DELETED originating record refuses — deletion is ambiguous", async () => {
    const taskId = await seedTask(CO_A, { status: "in_progress" });
    const itemId = await seedItem(CO_A, taskId);
    await q(`delete from tasks where id = $1`, [taskId]);

    const out = await run(itemId);
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("ambiguous");
    expect(out.transitioned).toBe(false);
    expect(await stateOf(itemId)).toBe("verifying");
  });

  it("an INCOMPLETE sweep yields pending and moves nothing", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId, { ...cleanSweep(), complete: false });
    expect(out.outcome).toBe("pending_clean_observation");
    expect(await stateOf(itemId)).toBe("verifying");
  });

  it("a RESET or abandoned generation yields pending", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId, { ...cleanSweep(), interrupted: true });
    expect(out.outcome).toBe("pending_clean_observation");
    expect(await stateOf(itemId)).toBe("verifying");
  });

  it("an observation taken BEFORE the claim refuses", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = await seedItem(CO_A, taskId);

    const out = await run(itemId, {
      ...cleanSweep(),
      observedAt: new Date(Date.now() - 2 * 3600_000), // before the seeded claim
    });
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("not later than");
  });
});

describe.skipIf(!enabled)("company and identity boundaries", () => {
  it("a CROSS-COMPANY item is not verifiable from another company", async () => {
    const taskId = await seedTask(CO_B, { status: "completed" });
    const itemId = await seedItem(CO_B, taskId);

    // Asked in company A, about company B's item.
    const out = await verifyManagementOutcome(env, {
      companyId: CO_A, itemId, actorId: ACTOR, sweep: cleanSweep(),
    });
    expect(out.outcome).toBe("unavailable");
    expect(out.transitioned).toBe(false);
    expect(await stateOf(itemId)).toBe("verifying");
  });

  it("a domain with no rule refuses, naming itself", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = await seedItem(CO_A, taskId, { department: "finance" });

    const out = await run(itemId);
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("finance");
    expect(await stateOf(itemId)).toBe("verifying");
  });

  it("an item with no recorded completion claim is not verifiable", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = randomUUID();
    await q(
      `insert into management_items
         (id, company_id, department, kind, subject_table, subject_id, identity_key, state,
          accountable_owner_id)
       values ($1,$2,'operations','overdue','tasks',$3,$4,'verifying',$5)`,
      [itemId, CO_A, taskId, `${CO_A}:noclaim:${itemId}`, membershipOf.get(CO_A)!],
    );
    const out = await run(itemId);
    expect(out.outcome).toBe("unavailable");
    expect(out.transitioned).toBe(false);
  });
});

describe.skipIf(!enabled)("concurrency", () => {
  it("SIMULTANEOUS verification cannot produce two terminal outcomes", async () => {
    const taskId = await seedTask(CO_A, { status: "completed" });
    const itemId = await seedItem(CO_A, taskId);

    const clients = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const c = new pg.Client({ connectionString: URL, ssl: false });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.all(
        clients.map((c) =>
          verifyManagementOutcome(
            {
              sql: async (text, params) => {
                const r = await c.query(text, params as unknown[]);
                return { rows: r.rows as Record<string, unknown>[] };
              },
              now: NOW,
            },
            { companyId: CO_A, itemId, actorId: ACTOR, sweep: cleanSweep() },
          ),
        ),
      );
      // Both may reach the same conclusion; only one may MOVE the lifecycle.
      expect(results.filter((r) => r.transitioned)).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    expect(await stateOf(itemId)).toBe("verified");
    const { rows } = await q(
      `select count(*)::int as n from management_item_transitions
        where item_id = $1 and to_state in ('verified','reopened')`,
      [itemId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a REOPENED item is not verifiable again without a fresh claim", async () => {
    const taskId = await seedTask(CO_A, { status: "in_progress", dueDate: "2020-01-01" });
    const itemId = await seedItem(CO_A, taskId);

    expect((await run(itemId)).outcome).toBe("condition_persists");
    expect(await stateOf(itemId)).toBe("reopened");

    // `reopened` does not admit a verification conclusion.
    const again = await run(itemId);
    expect(again.outcome).toBe("unavailable");
    expect(again.transitioned).toBe(false);
  });
});
