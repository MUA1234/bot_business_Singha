/**
 * Scheduled outcome verification: bounded, fair, and honest about what it did not do.
 *
 * The two failure modes this file exists to rule out:
 *
 *   * a permanently unverifiable item at the front of the queue consuming every cycle's budget
 *     while everything behind it is never attempted;
 *   * a cycle reporting calm completion while verification work remains unknown.
 *
 * Every run is against real PostgreSQL, through the real service, with no model involved.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createSqlVerificationStore } from "@/kernel/verification/store-sql";
import {
  runVerificationSweep,
  backoffMinutesFor,
  VERIFICATION_BUDGET_PER_CYCLE,
} from "@/kernel/verification/schedule";
import type { SqlExec } from "@/kernel/execution/ledger";
import type { SweepState } from "@/kernel/verification/contract";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const ACTOR = randomUUID();
const membershipOf = new Map<string, string>();

let raw: pg.Client;
const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const sql: SqlExec = async (text, params) => {
  const r = await raw.query(text, params as unknown[]);
  return { rows: r.rows as Record<string, unknown>[] };
};
const env = { store: createSqlVerificationStore(sql), now: () => new Date() };

const cleanSweep = (): SweepState => ({
  complete: true,
  generation: "gen-sched",
  interrupted: false,
  observedAt: new Date(Date.now() + 60_000),
});

async function seedTask(company: string, status = "completed", dueDate = "2020-01-01") {
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, requires_evidence)
     values ($1,'Scheduled check',$2,$3::date,false) returning id`,
    [company, status, dueDate],
  );
  return String(rows[0].id);
}

/** A pending item, with a recorded completion claim an hour ago. */
async function seedPending(
  company: string,
  taskId: string,
  opts: { department?: string } = {},
): Promise<string> {
  const itemId = randomUUID();
  await q(
    `insert into management_items
       (id, company_id, department, kind, subject_table, subject_id, identity_key, state,
        accountable_owner_id)
     values ($1,$2,$3,'overdue','tasks',$4,$5,'verifying',$6)`,
    [itemId, company, opts.department ?? "operations", taskId,
     `${company}:sched:${itemId}`, membershipOf.get(company)!],
  );
  await q(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id)
     values ($1,$2,'tasks',$3)`,
    [company, itemId, taskId],
  );
  await q(
    `insert into management_item_transitions
       (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, created_at)
     values ($1,$2,'monitoring','verifying',$3,'user','claimed complete', now() - interval '1 hour')`,
    [company, itemId, ACTOR],
  );
  return itemId;
}

/**
 * A fresh company per test.
 *
 * Cleaning up instead would mean deleting attempt history — which is append-only, correctly — or
 * forcing item states past the lifecycle boundary, which is also correctly refused. Isolation by
 * company is the only approach that does not require defeating a guard to set up a test.
 */
async function freshCompany(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into companies (id, name, base_currency) values ($1,$2,'LKR')`,
    [id, `SCHED ${id.slice(0, 8)}`],
  );
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
    [id, ACTOR],
  );
  membershipOf.set(id, String(rows[0].id));
  return id;
}

beforeAll(async () => {
  if (!enabled) return;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  await q(
    `insert into users (id, email, full_name) values ($1,$2,'Scheduler actor')
       on conflict (id) do nothing`,
    [ACTOR, `sched-${ACTOR.slice(0, 8)}@example.invalid`],
  );
});

afterAll(async () => {
  if (!enabled) return;
  await raw?.end();
});

/**
 * Required company argument, deliberately. A default would bind to the module-level constant and
 * silently sweep the wrong company when a test uses its own.
 */
const sweep = (
  companyId: string,
  over: Partial<Parameters<typeof runVerificationSweep>[1]> = {},
) => runVerificationSweep(env, { companyId, sweep: cleanSweep(), cycleComplete: true, ...over });

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("a scheduled verification runs and reports truthfully", () => {
  it("verifies a resolved item and counts it", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));

    const s = await sweep(CO);
    expect(s.considered).toBe(1);
    expect(s.attempted).toBe(1);
    expect(s.verified).toBe(1);
    expect(s.remaining).toBe(0);
    expect(s.partial).toBe(false);

    const { rows } = await q(`select state from management_items where id = $1`, [itemId]);
    expect(rows[0].state).toBe("verified");
  });

  it("reopens a persisting condition and counts it as persists, not verified", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "in_progress", "2020-01-01"));

    const s = await sweep(CO);
    expect(s.persists).toBe(1);
    expect(s.verified).toBe(0);
    const { rows } = await q(`select state from management_items where id = $1`, [itemId]);
    expect(rows[0].state).toBe("reopened");
  });

  it("records an append-only attempt with the observation it was drawn from", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));
    await sweep(CO);

    const { rows } = await q(
      `select attempt_no, outcome, observed_at, generation, actor_type
         from management_verification_attempts where item_id = $1`,
      [itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_no).toBe(1);
    expect(rows[0].outcome).toBe("verified_resolved");
    expect(rows[0].generation).toBe("gen-sched");
    // A scheduled attempt is the SYSTEM's act, which is what keeps it out of person-learning.
    expect(rows[0].actor_type).toBe("system");

    await expect(
      q(`update management_verification_attempts set outcome = 'x' where item_id = $1`, [itemId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      q(`delete from management_verification_attempts where item_id = $1`, [itemId]),
    ).rejects.toThrow(/append-only/i);
  });
});

describe.skipIf(!enabled)("a partial cycle verifies nothing", () => {
  it("defers every pending item and reports partial", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));

    const s = await sweep(CO, { cycleComplete: false });
    expect(s.attempted).toBe(0);
    expect(s.deferred).toBe(1);
    expect(s.partial).toBe(true);
    expect(s.remaining).toBe(1);

    // And nothing moved.
    const { rows } = await q(`select state from management_items where id = $1`, [itemId]);
    expect(rows[0].state).toBe("verifying");
  });

  it("an interrupted source generation yields pending, and the item stays", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));

    const s = await sweep(CO, { sweep: { ...cleanSweep(), interrupted: true } });
    expect(s.attempted).toBe(1);
    expect(s.unavailable).toBe(1);
    expect(s.verified).toBe(0);
    expect(s.partial).toBe(true);
    const { rows } = await q(`select state from management_items where id = $1`, [itemId]);
    expect(rows[0].state).toBe("verifying");
  });
});

describe.skipIf(!enabled)("bounded fairness", () => {
  it("attempts at most the budget, defers the rest, and says work remains", async () => {
    const CO = await freshCompany();
    const n = VERIFICATION_BUDGET_PER_CYCLE + 4;
    for (let i = 0; i < n; i++) {
      await seedPending(CO, await seedTask(CO, "completed"));
    }

    const s = await sweep(CO);
    expect(s.considered).toBe(n);
    expect(s.attempted).toBe(VERIFICATION_BUDGET_PER_CYCLE);
    expect(s.deferred).toBe(n - VERIFICATION_BUDGET_PER_CYCLE);
    expect(s.partial, "work remains, so the cycle is not calm").toBe(true);
    expect(s.remaining).toBe(n - VERIFICATION_BUDGET_PER_CYCLE);
  });

  it("N pending items complete within a MEASURED bound of ceil(N / budget) cycles", async () => {
    const CO = await freshCompany();
    const n = VERIFICATION_BUDGET_PER_CYCLE * 2 + 3;
    for (let i = 0; i < n; i++) {
      await seedPending(CO, await seedTask(CO, "completed"));
    }

    let cycles = 0;
    let last = await sweep(CO);
    cycles++;
    while (last.remaining > 0 && cycles < 20) {
      last = await sweep(CO);
      cycles++;
    }

    expect(last.remaining).toBe(0);
    // The bound, stated and asserted rather than assumed.
    expect(cycles).toBeLessThanOrEqual(Math.ceil(n / VERIFICATION_BUDGET_PER_CYCLE));
    // eslint-disable-next-line no-console
    console.log(
      `=== VERIFICATION BOUND: ${n} pending items cleared in ${cycles} cycles ` +
        `(budget ${VERIFICATION_BUDGET_PER_CYCLE}/cycle, arithmetic bound ` +
        `${Math.ceil(n / VERIFICATION_BUDGET_PER_CYCLE)})`,
    );
  });

  it("a PERMANENTLY unverifiable first item does not starve the ones behind it", async () => {
    const CO = await freshCompany();
    // Its originating record is gone, so every attempt concludes `unavailable` — for ever.
    const doomedTask = await seedTask(CO, "in_progress");
    const doomed = await seedPending(CO, doomedTask);
    await q(`delete from tasks where id = $1`, [doomedTask]);
    // Give it the earliest possible position in the queue.
    await q(
      `insert into management_verification_schedule (company_id, item_id, next_attempt_at)
       values ($1,$2, now() - interval '1 day')`,
      [CO, doomed],
    );

    const good = await seedPending(CO, await seedTask(CO, "completed"));

    // First cycle: the doomed item is attempted, concludes unavailable, and steps back.
    const first = await sweep(CO);
    expect(first.attempted).toBeGreaterThanOrEqual(1);
    expect(first.unavailable).toBeGreaterThanOrEqual(1);

    // The item behind it is reached — in this cycle or, once backoff applies, the next.
    let state = (await q(`select state from management_items where id = $1`, [good])).rows[0].state;
    if (state === "verifying") {
      await sweep(CO);
      state = (await q(`select state from management_items where id = $1`, [good])).rows[0].state;
    }
    expect(state, "the later item must be reached").toBe("verified");

    // And the doomed item is still visible as pending with a recorded reason, not silently dropped.
    const { rows } = await q(
      `select attempts, last_outcome from management_verification_schedule
        where company_id = $1 and item_id = $2`,
      [CO, doomed],
    );
    expect(Number(rows[0].attempts)).toBeGreaterThanOrEqual(1);
    expect(rows[0].last_outcome).toBe("unavailable");
  });

  it("backoff is bounded and increases, so a failing item steps back rather than spinning", () => {
    const steps = [1, 2, 3, 4, 5, 6, 20].map(backoffMinutesFor);
    expect(steps[0]).toBeLessThan(steps[1]!);
    expect(steps[1]).toBeLessThan(steps[2]!);
    // Bounded: it stops growing rather than running away.
    expect(steps[5]).toBe(steps[4]);
    expect(steps[6]).toBe(steps[4]);
  });

  it("an item in backoff is DEFERRED, not attempted, and does not consume budget", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));
    await q(
      `insert into management_verification_schedule (company_id, item_id, attempts, next_attempt_at)
       values ($1,$2,1, now() + interval '1 hour')`,
      [CO, itemId],
    );

    const s = await sweep(CO);
    expect(s.attempted).toBe(0);
    expect(s.deferred).toBe(1);
    expect(s.partial).toBe(true);
  });
});

describe.skipIf(!enabled)("company isolation and unsupported domains", () => {
  it("a sweep for one company never touches another's items", async () => {
    const CO = await freshCompany();
    const CO_B = await freshCompany();
    const mine = await seedPending(CO, await seedTask(CO, "completed"));
    const theirs = await seedPending(CO_B, await seedTask(CO_B, "completed"));

    const s = await sweep(CO);
    expect(s.considered).toBe(1);

    expect((await q(`select state from management_items where id=$1`, [mine])).rows[0].state)
      .toBe("verified");
    expect((await q(`select state from management_items where id=$1`, [theirs])).rows[0].state)
      .toBe("verifying");
  });

  it("an unsupported domain is attempted, concluded unavailable, and never verified", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"), {
      department: "finance",
    });

    const s = await sweep(CO);
    expect(s.attempted).toBe(1);
    expect(s.unavailable).toBe(1);
    expect(s.verified).toBe(0);
    expect((await q(`select state from management_items where id=$1`, [itemId])).rows[0].state)
      .toBe("verifying");

    const { rows } = await q(
      `select outcome, detail from management_verification_attempts where item_id = $1`, [itemId],
    );
    expect(rows[0].outcome).toBe("unavailable");
    expect(String(rows[0].detail)).toContain("finance");
  });
});

describe.skipIf(!enabled)("idempotence and concurrency", () => {
  it("re-running a sweep does not re-verify an already terminal item", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));

    expect((await sweep(CO)).verified).toBe(1);
    const second = await sweep(CO);
    expect(second.considered).toBe(0);
    expect(second.attempted).toBe(0);

    const { rows } = await q(
      `select count(*)::int as n from management_item_transitions
        where item_id = $1 and to_state = 'verified'`,
      [itemId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("SIMULTANEOUS sweeps produce exactly one terminal transition", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));

    const clients = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const c = new pg.Client({ connectionString: URL, ssl: false });
        await c.connect();
        return c;
      }),
    );
    try {
      await Promise.allSettled(
        clients.map((c) =>
          runVerificationSweep(
            {
              store: createSqlVerificationStore(async (text, params) => {
                const r = await c.query(text, params as unknown[]);
                return { rows: r.rows as Record<string, unknown>[] };
              }),
              now: () => new Date(),
            },
            { companyId: CO, sweep: cleanSweep(), cycleComplete: true },
          ),
        ),
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    const { rows } = await q(
      `select count(*)::int as n from management_item_transitions
        where item_id = $1 and to_state in ('verified','reopened')`,
      [itemId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("one item's failure does not suppress or falsely complete another", async () => {
    const CO = await freshCompany();
    const doomedTask = await seedTask(CO, "in_progress");
    const doomed = await seedPending(CO, doomedTask);
    await q(`delete from tasks where id = $1`, [doomedTask]);
    const good = await seedPending(CO, await seedTask(CO, "completed"));

    const s = await sweep(CO);
    expect(s.attempted).toBe(2);
    expect(s.unavailable).toBe(1);
    expect(s.verified).toBe(1);

    expect((await q(`select state from management_items where id=$1`, [doomed])).rows[0].state)
      .toBe("verifying");
    expect((await q(`select state from management_items where id=$1`, [good])).rows[0].state)
      .toBe("verified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Batch 3 — verified outcomes and learning.
//
// The guarantees here are enforced by the EXISTING fold in `people/learning.ts`, not by anything
// added for this. These tests prove they hold under the new machine writer, which is the part that
// was never exercised before: until now nothing wrote a `verified` or `reopened` transition at all.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("machine verification never becomes evidence about a person", () => {
  it("a scheduled transition is recorded as SYSTEM, with no actor", async () => {
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "completed"));
    await sweep(CO);

    const { rows } = await q(
      `select actor_type, actor_id from management_item_transitions
        where item_id = $1 and to_state = 'verified'`,
      [itemId],
    );
    expect(rows).toHaveLength(1);
    // Not 'user'. The learning fold reads this column to decide whether an outcome is evidence
    // about someone, and a machine conclusion must not look like a person's.
    expect(rows[0].actor_type).toBe("system");
    expect(rows[0].actor_id).toBeNull();
  });

  it("a persisting condition is recorded as SYSTEM too, so it cannot score against anyone", async () => {
    // The prohibited behaviour, checked at its source: `condition_persists` writes `reopened`,
    // and `reopened` carries -1 in the polarity table. It is excluded because the decider is
    // neither a person nor attributed.
    const CO = await freshCompany();
    const itemId = await seedPending(CO, await seedTask(CO, "in_progress", "2020-01-01"));
    await sweep(CO);

    const { rows } = await q(
      `select actor_type, actor_id from management_item_transitions
        where item_id = $1 and to_state = 'reopened'`,
      [itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("system");
    expect(rows[0].actor_id).toBeNull();
  });

  it("an UNAVAILABLE verification writes no transition at all, so learning sees nothing", async () => {
    const CO = await freshCompany();
    const doomedTask = await seedTask(CO, "in_progress");
    const itemId = await seedPending(CO, doomedTask);
    await q(`delete from tasks where id = $1`, [doomedTask]);

    await sweep(CO);
    const { rows } = await q(
      `select count(*)::int as n from management_item_transitions
        where item_id = $1 and to_state in ('verified','reopened')`,
      [itemId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("execution and task creation write no outcome transition either", async () => {
    // Creating a task is an effect. It is not an outcome, and it must reach learning by no route.
    const CO = await freshCompany();
    const created = await q(
      `select * from r1_draft_create_internal_task($1,$2,$3,null,false,$4)`,
      [CO, `learn-${randomUUID()}`, "An effect, not an outcome", ACTOR],
    );
    expect(created.rows[0].created).toBe(true);

    const { rows } = await q(
      `select count(*)::int as n from management_item_transitions
        where company_id = $1 and to_state in ('verified','reopened')`,
      [CO],
    );
    expect(rows[0].n).toBe(0);
  });

  it("attempt history is preserved for corrections — superseded, never deleted", async () => {
    const CO = await freshCompany();
    const taskId = await seedTask(CO, "in_progress", "2020-01-01");
    const itemId = await seedPending(CO, taskId);

    // First conclusion: the condition persists.
    await sweep(CO);
    // The world changes and a later attempt would conclude differently — but the first attempt
    // stays on the record.
    await q(`update tasks set status = 'completed' where id = $1`, [taskId]);

    const { rows } = await q(
      `select attempt_no, outcome from management_verification_attempts
        where item_id = $1 order by attempt_no`,
      [itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("condition_persists");
    // And it cannot be rewritten to match the newer reality.
    await expect(
      q(`update management_verification_attempts set outcome = 'verified_resolved' where item_id = $1`,
        [itemId]),
    ).rejects.toThrow(/append-only/i);
  });
});
