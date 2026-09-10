/**
 * R2B runtime — the feedback path enforced AT THE DATABASE (owner Decision 3).
 *
 * The application module refuses bad requests. This proves the database refuses them again,
 * independently, through `r1_draft_record_feedback` — because the rules protect a learning input,
 * and a forged row there does not merely record something false, it changes future
 * recommendations about a person.
 *
 * Synthetic data, disposable local PostgreSQL. Run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();

let db: pg.Client;
const mem = new Map<string, string>();

async function seedPerson(companyId: string, label: string, roleKey: string | null, status = "active") {
  const userId = randomUUID();
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [userId]);
  await db.query(
    `insert into users (id, full_name, is_active) values ($1,$2,true) on conflict (id) do nothing`,
    [userId, `R2B ${label}`],
  );
  const { rows } = await db.query(
    `insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`,
    [companyId, userId, status],
  );
  const id = rows[0].id as string;
  if (roleKey) {
    await db.query(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`,
      [id, companyId, roleKey],
    );
  }
  mem.set(label, id);
  return id;
}

async function seedItem(companyId: string, state = "observed"): Promise<string> {
  const { rows } = await db.query(
    `insert into management_items
       (company_id, department, kind, subject_table, subject_id, identity_key, state,
        priority, confidence, required_authority, proposed_action_id)
     values ($1,'operations','task_exception','tasks',$2,$3,$4,'high',1,'manager_approval',
             'ops.task.create_internal')
     returning id`,
    [companyId, randomUUID(), `k-${randomUUID()}`, state],
  );
  const id = rows[0].id as string;
  await db.query(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts, origin)
     values ($1,$2,'tasks',$3,'{"overdue_days":9}'::jsonb,'detector')`,
    [companyId, id, randomUUID()],
  );
  return id;
}

const record = (args: Record<string, unknown>) => {
  const a = {
    p_company: CO_A, p_item: null, p_actor: null, p_feedback_type: "recommendation_accepted",
    p_subject: null, p_proposed: null, p_actual: null, p_reason: null, p_comment: null,
    p_supersedes: null, ...args,
  };
  const order = ["p_company", "p_item", "p_actor", "p_feedback_type", "p_subject",
                 "p_proposed", "p_actual", "p_reason", "p_comment", "p_supersedes"];
  const params = order.map((k) => {
    const v = (a as Record<string, unknown>)[k];
    return (k === "p_proposed" || k === "p_actual") && v !== null ? JSON.stringify(v) : v;
  });
  return db.query(
    `select public.r1_draft_record_feedback(${order.map((_, i) => `$${i + 1}`).join(",")}) as r`,
    params,
  );
};

describe.skipIf(!enabled)("R2B feedback runtime, enforced at the database", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    for (const co of [CO_A, CO_B]) {
      await db.query(
        `insert into companies (id, name, base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `R2Bfb ${co.slice(0, 8)}`],
      );
    }
    await seedPerson(CO_A, "manager", "project_manager");
    await seedPerson(CO_A, "worker", "staff_submitter");
    await seedPerson(CO_A, "outsider", "accountant");   // holds no task capability
    await seedPerson(CO_A, "revoked", "project_manager", "suspended");
    await seedPerson(CO_B, "foreign", "project_manager");
  });

  afterAll(async () => { await db?.end(); });

  describe("who may record feedback", () => {
    it("accepts an active, authorised member of the item's company", async () => {
      const item = await seedItem(CO_A);
      const { rows } = await record({ p_item: item, p_actor: mem.get("manager")! });
      expect(rows[0].r.ok).toBe(true);
      expect(rows[0].r.feedback_id).toBeTruthy();
    });

    it("REFUSES an actor with no task capability", async () => {
      const item = await seedItem(CO_A);
      await expect(record({ p_item: item, p_actor: mem.get("outsider")! }))
        .rejects.toThrow(/not an active authorised member/);
    });

    it("REFUSES a revoked member", async () => {
      const item = await seedItem(CO_A);
      await expect(record({ p_item: item, p_actor: mem.get("revoked")! }))
        .rejects.toThrow(/not an active authorised member/);
    });

    it("REFUSES anonymous feedback", async () => {
      const item = await seedItem(CO_A);
      await expect(record({ p_item: item, p_actor: null }))
        .rejects.toThrow(/requires an identified human actor/);
    });

    it("FEEDBACK FOR ANOTHER COMPANY FAILS", async () => {
      const foreignItem = await seedItem(CO_B);
      await expect(record({ p_item: foreignItem, p_actor: mem.get("manager")! }))
        .rejects.toThrow(/belongs to another company/);

      // And a company-A member cannot reach it by claiming company B either: the actor is
      // then not a member of the company the item belongs to.
      await expect(record({ p_company: CO_B, p_item: foreignItem, p_actor: mem.get("manager")! }))
        .rejects.toThrow(/not an active authorised member/);
    });

    it("REFUSES a SUBJECT membership from another company", async () => {
      // Feedback names WHO IT IS ABOUT. Without a company check on that field, a manager could
      // record an unsuccessful outcome against someone in a company they have no relationship
      // with, and it would feed that company's learning fold.
      const item = await seedItem(CO_A);
      await expect(record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "outcome_unsuccessful",
        p_subject: mem.get("foreign")!,
      })).rejects.toThrow(/subject .* is not a member of company|not a member/i);
    });

    it("records the actor as a HUMAN — there is no parameter to claim otherwise", async () => {
      const item = await seedItem(CO_A);
      await record({ p_item: item, p_actor: mem.get("manager")! });
      const { rows } = await db.query(
        `select actor_type from management_item_feedback where item_id = $1`, [item],
      );
      expect(rows[0].actor_type).toBe("user");
    });
  });

  describe("a verified outcome requires the lifecycle evidence", () => {
    it("REFUSES outcome_successful when the item never reached `verified`", async () => {
      const item = await seedItem(CO_A);
      await expect(record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "outcome_successful",
        p_subject: mem.get("worker")!,
      })).rejects.toThrow(/requires the item to have reached `verified`/);
    });

    it("ACCEPTS it once the item actually reached `verified`", async () => {
      const item = await seedItem(CO_A);
      await db.query(
        `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_id,actor_type)
         values ($1,$2,'verifying','verified',$3,'user')`,
        [CO_A, item, mem.get("manager")!],
      );
      const { rows } = await record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "outcome_successful",
        p_subject: mem.get("worker")!,
      });
      expect(rows[0].r.ok).toBe(true);
    });

    it("REOPENED WORK IS NOT SUCCESSFUL COMPLETION", async () => {
      const item = await seedItem(CO_A);
      await db.query(
        `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_id,actor_type,created_at)
         values ($1,$2,'verifying','verified',$3,'user', now() - interval '2 hours')`,
        [CO_A, item, mem.get("manager")!],
      );
      await db.query(
        `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_id,actor_type,created_at)
         values ($1,$2,'verified','reopened',$3,'user', now() - interval '1 hour')`,
        [CO_A, item, mem.get("manager")!],
      );
      await expect(record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "outcome_successful",
        p_subject: mem.get("worker")!,
      })).rejects.toThrow(/reopened after its last verification/);
    });

    it("an UNSUCCESSFUL outcome needs no verification evidence — it is a claim of failure", async () => {
      const item = await seedItem(CO_A);
      const { rows } = await record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "outcome_unsuccessful",
        p_subject: mem.get("worker")!,
      });
      expect(rows[0].r.ok).toBe(true);
    });
  });

  describe("one manager cannot fabricate hundreds of independent outcomes", () => {
    it("refuses a SECOND identical entry for the same item, actor and type", async () => {
      const item = await seedItem(CO_A);
      await record({ p_item: item, p_actor: mem.get("manager")! });
      await expect(record({ p_item: item, p_actor: mem.get("manager")! }))
        .rejects.toThrow(/already exists for item .* supply supersedes_id/);
    });

    it("caps how many entries of one type a single actor may write in a day", async () => {
      const actor = await seedPerson(CO_A, "flooder", "project_manager");
      let refusedAt = -1;
      for (let i = 0; i < 60; i++) {
        const item = await seedItem(CO_A);
        try {
          await record({ p_item: item, p_actor: actor, p_feedback_type: "recommendation_rejected" });
        } catch (e) {
          expect((e as Error).message).toMatch(/has already recorded/);
          refusedAt = i;
          break;
        }
      }
      expect(refusedAt).toBeGreaterThan(0);
      expect(refusedAt).toBeLessThan(60);
    });
  });

  describe("corrections supersede without deleting", () => {
    it("keeps the superseded row exactly as written", async () => {
      const item = await seedItem(CO_A);
      const first = await record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "recommendation_rejected",
        p_reason: "wrong person",
      });
      const firstId = first.rows[0].r.feedback_id as string;

      await record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "correction_supplied",
        p_reason: "actually the right person; I misread the queue", p_supersedes: firstId,
      });

      const { rows } = await db.query(
        `select id, reason, supersedes_id from management_item_feedback
          where item_id = $1 order by created_at`, [item],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].reason).toBe("wrong person");         // untouched
      expect(rows[1].supersedes_id).toBe(firstId);
    });

    it("refuses a correction that crosses items", async () => {
      const a = await seedItem(CO_A);
      const b = await seedItem(CO_A);
      const first = await record({ p_item: a, p_actor: mem.get("worker")! });
      await expect(record({
        p_item: b, p_actor: mem.get("worker")!, p_feedback_type: "correction_supplied",
        p_supersedes: first.rows[0].r.feedback_id,
      })).rejects.toThrow(/SAME management item/);
    });

    it("refuses TWO corrections of the same row — the fold must not have to guess", async () => {
      const item = await seedItem(CO_A);
      const first = await record({ p_item: item, p_actor: mem.get("worker")!, p_feedback_type: "result_disputed" });
      const id = first.rows[0].r.feedback_id;
      await record({
        p_item: item, p_actor: mem.get("worker")!, p_feedback_type: "correction_supplied", p_supersedes: id,
      });
      await expect(record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "correction_supplied", p_supersedes: id,
      })).rejects.toThrow();
    });
  });

  describe("append-only, and the RPC is the only door", () => {
    it("refuses UPDATE and DELETE", async () => {
      const item = await seedItem(CO_A);
      await record({ p_item: item, p_actor: mem.get("manager")! });
      await expect(db.query(`update management_item_feedback set reason = 'x' where item_id = $1`, [item]))
        .rejects.toThrow(/append-only/);
      await expect(db.query(`delete from management_item_feedback where item_id = $1`, [item]))
        .rejects.toThrow(/append-only/);
    });

    it("refuses a DIRECT insert that would bypass every rule above", async () => {
      const item = await seedItem(CO_A);
      // SET ROLE is essential. The guard gates the API roles (anon/authenticated/service_role);
      // the test connection is the postgres SUPERUSER, for whom it correctly does not fire. An
      // earlier version of this test asserted the refusal as postgres, and passed the insert
      // while claiming to have proven a boundary.
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        // The PROPERTY under test is that no row appears — not which of several boundaries
        // refused first. Asserting a particular message would test the ordering of the guards.
        await expect(db.query(
          `insert into management_item_feedback (company_id, item_id, feedback_type, actor_id, actor_type)
           values ($1,$2,'outcome_successful',$3,'user')`,
          [CO_A, item, mem.get("manager")!],
        )).rejects.toThrow();
      } finally {
        await db.query("rollback");
      }
      const { rows } = await db.query(
        `select count(*)::int as n from management_item_feedback where item_id = $1`, [item],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe("bounded comments", () => {
    it("truncates rather than storing an unbounded blob", async () => {
      const item = await seedItem(CO_A);
      await record({ p_item: item, p_actor: mem.get("manager")!, p_comment: "y".repeat(9000) });
      const { rows } = await db.query(
        `select char_length(comment) as n from management_item_feedback where item_id = $1`, [item],
      );
      expect(rows[0].n).toBe(2000);
    });
  });

  describe("feedback changes no authority and no employment state", () => {
    it("leaves roles, capabilities and membership status untouched", async () => {
      const worker = mem.get("worker")!;
      const before = await db.query(
        `select (select count(*) from membership_roles where membership_id=$1) as roles,
                (select status from memberships where id=$1) as status`, [worker],
      );
      const item = await seedItem(CO_A);
      await db.query(
        `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_id,actor_type)
         values ($1,$2,'verifying','verified',$3,'user')`,
        [CO_A, item, mem.get("manager")!],
      );
      await record({
        p_item: item, p_actor: mem.get("manager")!, p_feedback_type: "outcome_unsuccessful",
        p_subject: worker, p_reason: "missed the deadline twice",
      });
      const after = await db.query(
        `select (select count(*) from membership_roles where membership_id=$1) as roles,
                (select status from memberships where id=$1) as status`, [worker],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });
});
