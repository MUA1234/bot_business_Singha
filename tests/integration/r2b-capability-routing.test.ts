/**
 * R2B checkpoint 6 — the adversarial scenario campaign, on a LIVE database.
 *
 * The resolver is pure, so most of its rules are already proven in the unit suite. What CANNOT be
 * proven there is what happens when the world moves underneath a recommendation: a membership is
 * revoked between resolution and commit, two managers assign at the same instant, a candidate is
 * fabricated from another company. Those need real rows, real roles, real constraints and two
 * real connections.
 *
 * Every candidate here is built from evidence LOADED FROM THE DATABASE, not hand-written — so a
 * test that passes proves the production loader shape works, not just that the fixture did.
 *
 * Synthetic data only. Disposable local PostgreSQL only. Run via
 * scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  candidateEvidence, type AvailabilitySignal, type CandidateEvidence, type CandidateRequest,
} from "@/kernel/people/candidate";
import { fact } from "@/kernel/people/evidence";
import { assertSingleCompany, resolveCandidates } from "@/kernel/people/resolve";
import { buildSignal, type OutcomeRecord } from "@/kernel/people/learning";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const NOW = new Date("2026-09-02T09:00:00.000Z");

let db: pg.Client;
let db2: pg.Client;

/** membershipId per person, filled by the fixture. */
const mem = new Map<string, string>();

async function seedPerson(
  client: pg.Client,
  companyId: string,
  label: string,
  roleKey: string | null,
  status = "active",
): Promise<string> {
  const userId = randomUUID();
  // auth.users first: profiles.id references it (migration 0007).
  await client.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [userId]);
  await client.query(
    `insert into users (id, full_name, is_active) values ($1, $2, true) on conflict (id) do nothing`,
    [userId, `R2B ${label}`],
  );
  await client.query(
    `insert into profiles (id, company_id, username, full_name, department, is_active)
       values ($1,$2,$3,$4,'operations',true) on conflict (id) do nothing`,
    [userId, companyId, `r2b_${label.replace(/-/g, "_")}_${userId.slice(0, 8)}`, `R2B ${label}`],
  );
  const { rows } = await client.query(
    `insert into memberships (company_id, user_id, status) values ($1, $2, $3) returning id`,
    [companyId, userId, status],
  );
  const membershipId = rows[0].id as string;
  if (roleKey) {
    await client.query(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1, $2, $3)`,
      [membershipId, companyId, roleKey],
    );
  }
  mem.set(label, membershipId);
  return membershipId;
}

/** Read a membership's REAL capabilities through the existing role_permissions mapping. */
async function loadCapabilities(client: pg.Client, membershipId: string): Promise<string[]> {
  const { rows } = await client.query(
    `select distinct rp.permission_key as k
       from membership_roles mr
       join role_permissions rp on rp.role_key = mr.role_key
      where mr.membership_id = $1`,
    [membershipId],
  );
  return rows.map((r) => r.k as string);
}

/** Read REAL approved leave and decide availability from it — no hand-written flags. */
async function loadAvailability(
  client: pg.Client, membershipId: string, onDateIso: string,
): Promise<AvailabilitySignal> {
  const { rows } = await client.query(
    `select count(*)::int as n
       from leave_requests lr
       join memberships m on m.user_id = lr.profile_id and m.id = $1
      where lr.status = 'approved' and $2::date between lr.start_date and lr.end_date`,
    [membershipId, onDateIso],
  );
  const onLeave = (rows[0]?.n ?? 0) > 0;
  return {
    available: !onLeave,
    onLeave,
    availableHours: onLeave ? 0 : 20,
    capacityStatus: onLeave ? "overloaded" : "healthy",
  };
}

/** Build candidate evidence entirely from database reads. */
async function evidenceFor(
  client: pg.Client, companyId: string, membershipId: string, onDateIso: string,
): Promise<CandidateEvidence> {
  const { rows } = await client.query(`select status, company_id from memberships where id = $1`, [membershipId]);
  const row = rows[0];
  return candidateEvidence(
    { membershipId, companyId: row?.company_id ?? companyId, candidateType: "staff" },
    {
      active: fact(row?.status === "active", "verified", { sourceRef: { table: "memberships", id: membershipId } }),
      capabilities: fact(await loadCapabilities(client, membershipId), "verified", {
        sourceRef: { table: "membership_roles", id: membershipId },
      }),
      authorityLevel: fact("manager_approval", "verified"),
      available: fact(await loadAvailability(client, membershipId, onDateIso), "inferred", {
        asOf: "2026-09-01T00:00:00.000Z",
        sourceRef: { table: "leave_requests", id: membershipId },
      }),
    },
  );
}

const request = (over: Partial<CandidateRequest> = {}): CandidateRequest => ({
  companyId: CO_A, department: "operations", taskKind: "operations.task_exception",
  roles: ["assignee"], requiredCapability: "operations.task.manage",
  requiredAuthority: "manager_approval", authorityAmount: null, authorityDomain: null,
  requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
  onDateIso: "2026-09-02", estimateHours: 4, now: NOW, ...over,
});

/**
 * Create a management item ready to be assigned.
 *
 * The evidence row is NOT optional decoration. Draft unit 003 enforces INV-1 at the database:
 * an item cannot enter a working state with zero evidence. An earlier version of this helper
 * omitted it and every transition was correctly refused — the invariant caught the fixture.
 */
async function seedItem(client: pg.Client, companyId: string): Promise<string> {
  const { rows } = await client.query(
    `insert into management_items
       (company_id, department, kind, subject_table, subject_id, identity_key, state,
        priority, confidence, required_authority)
     values ($1,'operations','task_exception','tasks',$2,$3,'approved','high',1,'manager_approval')
     returning id`,
    [companyId, randomUUID(), `k-${randomUUID()}`],
  );
  const id = rows[0].id as string;
  await client.query(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts, origin)
     values ($1,$2,'tasks',$3,'{"overdue_days":9}'::jsonb,'detector')`,
    [companyId, id, randomUUID()],
  );
  return id;
}

describe.skipIf(!enabled)("R2B capability routing on a live database", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    db2 = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db2.connect();
    for (const c of [db, db2]) {
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }

    for (const co of [CO_A, CO_B]) {
      await db.query(`insert into companies (id, name, base_currency) values ($1,$2,'LKR')
                        on conflict (id) do nothing`, [co, `R2B ${co.slice(0, 8)}`]);
    }

    // Two managers and one person with no task capability, all in company A.
    await seedPerson(db, CO_A, "alice", "project_manager");
    await seedPerson(db, CO_A, "bob", "project_manager");
    await seedPerson(db, CO_A, "no-capability", "accountant");
    await seedPerson(db, CO_A, "suspended", "project_manager", "suspended");
    // A manager in a DIFFERENT company — the cross-company candidate.
    await seedPerson(db, CO_B, "foreign", "project_manager");
  });

  afterAll(async () => {
    await db?.end();
    await db2?.end();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  describe("the seeded roles genuinely carry the capability", () => {
    it("proves the fixture is discriminating before anything is asserted on it", async () => {
      const alice = await loadCapabilities(db, mem.get("alice")!);
      const none = await loadCapabilities(db, mem.get("no-capability")!);
      expect(alice).toContain("operations.task.manage");
      expect(none).not.toContain("operations.task.manage");
    });
  });

  describe("resolution from real rows", () => {
    it("recommends a real, capable, active member and refuses one without the capability", async () => {
      const candidates = await Promise.all(
        ["alice", "no-capability"].map((l) => evidenceFor(db, CO_A, mem.get(l)!, "2026-09-02")),
      );
      const r = resolveCandidates(request(), candidates);
      expect(r.candidates.map((c) => c.membershipId)).toEqual([mem.get("alice")!]);
      expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("capability_missing");
    });

    it("refuses a SUSPENDED membership read from the real row", async () => {
      const e = await evidenceFor(db, CO_A, mem.get("suspended")!, "2026-09-02");
      const r = resolveCandidates(request(), [e]);
      expect(r.outcome).toBe("needs_routing");
      expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("inactive");
      expect(r.rejected[0]!.neutral).toBe(false);
    });

    it("excludes a person on REAL approved leave, and calls it neutral", async () => {
      const { rows } = await db.query(`select user_id from memberships where id = $1`, [mem.get("bob")!]);
      await db.query(
        `insert into leave_requests (company_id, profile_id, start_date, end_date, days, status, decided_by, decided_at)
         values ($1,$2,'2026-09-01','2026-09-05',5,'approved',$3, now())`,
        [CO_A, rows[0].user_id, mem.get("alice")!],
      );

      const e = await evidenceFor(db, CO_A, mem.get("bob")!, "2026-09-02");
      const r = resolveCandidates(request(), [e]);
      expect(r.outcome).toBe("needs_routing");
      expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("on_approved_leave");
      expect(r.rejected[0]!.neutral).toBe(true);

      // The SAME person is available the following week — leave excludes for a date, not forever.
      const later = await evidenceFor(db, CO_A, mem.get("bob")!, "2026-09-10");
      const r2 = resolveCandidates(request({ onDateIso: "2026-09-10" }), [later]);
      expect(r2.candidates.map((c) => c.membershipId)).toEqual([mem.get("bob")!]);
    });
  });

  describe("cross-company candidates", () => {
    it("refuses a candidate whose real row belongs to another company", async () => {
      const foreign = await evidenceFor(db, CO_A, mem.get("foreign")!, "2026-09-02");
      expect(foreign.companyId).toBe(CO_B);
      const r = resolveCandidates(request(), [foreign]);
      expect(r.outcome).toBe("needs_routing");
      expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("company_mismatch");
    });

    it("makes a leaking loader LOUD", async () => {
      const mixed = await Promise.all([
        evidenceFor(db, CO_A, mem.get("alice")!, "2026-09-02"),
        evidenceFor(db, CO_A, mem.get("foreign")!, "2026-09-02"),
      ]);
      expect(() => assertSingleCompany(CO_A, mixed)).toThrow(/leaked across companies/);
    });

    it("THE DATABASE makes a cross-company owner unrepresentable, not merely refused", async () => {
      const item = await seedItem(db, CO_A);
      await expect(
        db.query(`update management_items set accountable_owner_id = $2 where id = $1`, [item, mem.get("foreign")!]),
      ).rejects.toThrow(/management_items_owner_company_fk|foreign key/i);
    });
  });

  describe("permission removal between recommendation and commit", () => {
    it("REFUSES an owner whose role was revoked after they were recommended", async () => {
      const victim = await seedPerson(db, CO_A, "revoked-later", "project_manager");

      // 1. Resolved as eligible on the evidence available at that moment.
      const before = resolveCandidates(request(), [await evidenceFor(db, CO_A, victim, "2026-09-02")]);
      expect(before.candidates.map((c) => c.membershipId)).toEqual([victim]);
      expect(await db.query(`select r1_draft_membership_can_own($1,$2) as ok`, [CO_A, victim])
        .then((r) => r.rows[0].ok)).toBe(true);

      // 2. The role is revoked — the world moved.
      await db.query(`delete from membership_roles where membership_id = $1`, [victim]);

      // 3. The DATABASE refuses to treat the stale recommendation as authorisation.
      const { rows } = await db.query(`select r1_draft_membership_can_own($1,$2) as ok`, [CO_A, victim]);
      expect(rows[0].ok).toBe(false);

      const item = await seedItem(db, CO_A);
      await db.query(`update management_items set accountable_owner_id = $2 where id = $1`, [item, victim]);
      await expect(db.query(`select r1_draft_assert_assignable($1)`, [item]))
        .rejects.toThrow(/not an active authorised membership/);

      // 4. And resolving AGAIN now refuses them, on the same code path.
      const after = resolveCandidates(request(), [await evidenceFor(db, CO_A, victim, "2026-09-02")]);
      expect(after.outcome).toBe("needs_routing");
      expect(after.rejected[0]!.reasons.map((x) => x.code)).toContain("capability_missing");
    });

    it("re-routes a live item whose owner lost authority — NEVER to an administrator", async () => {
      const victim = await seedPerson(db, CO_A, "revoked-inflight", "project_manager");
      const item = await seedItem(db, CO_A);
      // The state is moved through the RPC, never by a direct UPDATE: draft unit 010 makes the
      // lifecycle RPC-only, and an earlier version of this test tried to write it directly and
      // was correctly refused.
      await db.query(`update management_items set accountable_owner_id = $2 where id = $1`, [item, victim]);
      await db.query(
        `select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb)`,
        [item, victim],
      );

      await db.query(`update memberships set status = 'suspended' where id = $1`, [victim]);
      const { rows: reroute } = await db.query(`select r1_draft_revalidate_owners($1) as n`, [CO_A]);
      expect(reroute[0].n).toBeGreaterThanOrEqual(1);

      const { rows } = await db.query(
        `select state, accountable_owner_id, routing_reason, routing_department
           from management_items where id = $1`,
        [item],
      );
      expect(rows[0].state).toBe("needs_routing");
      expect(rows[0].accountable_owner_id).toBeNull();
      // The reason names the revocation, and nothing names an administrator or the owner.
      expect(rows[0].routing_reason).toBeTruthy();
      expect(String(rows[0].routing_reason)).not.toMatch(/administrator|owner_fallback/i);
      expect(rows[0].routing_department).toBeTruthy();
    });
  });

  describe("concurrent assignment", () => {
    it("lets exactly ONE of two simultaneous assignments win, with no lost update", async () => {
      const item = await seedItem(db, CO_A);
      const alice = mem.get("alice")!;
      const bob = mem.get("bob")!;

      await db.query("begin");
      await db2.query("begin");

      // Both transactions claim the item. The first takes the row lock.
      await db.query(
        `update management_items set accountable_owner_id = $2
          where id = $1 and accountable_owner_id is null`,
        [item, alice],
      );

      // The second blocks on the row until the first commits, then finds the guard false.
      const second = db2.query(
        `update management_items set accountable_owner_id = $2
          where id = $1 and accountable_owner_id is null`,
        [item, bob],
      );

      await db.query("commit");
      const result = await second;
      await db2.query("commit");

      // The guard is what makes this safe: the second update matched no row.
      expect(result.rowCount).toBe(0);

      const { rows } = await db.query(`select accountable_owner_id from management_items where id = $1`, [item]);
      expect(rows[0].accountable_owner_id).toBe(alice);
    });

    it("keeps a concurrent loser from silently overwriting the winner", async () => {
      const item = await seedItem(db, CO_A);
      await db.query(`update management_items set accountable_owner_id = $2 where id = $1`, [item, mem.get("alice")!]);
      const { rowCount } = await db.query(
        `update management_items set accountable_owner_id = $2
          where id = $1 and accountable_owner_id is null`,
        [item, mem.get("bob")!],
      );
      expect(rowCount).toBe(0);
    });
  });

  describe("no authority is expanded anywhere in this path", () => {
    it("gives a recommended person NO capability they did not already hold", async () => {
      const before = await loadCapabilities(db, mem.get("no-capability")!);
      resolveCandidates(request({ requiredCapability: null }), [
        await evidenceFor(db, CO_A, mem.get("no-capability")!, "2026-09-02"),
      ]);
      const after = await loadCapabilities(db, mem.get("no-capability")!);
      expect(after).toEqual(before);
      // And the database still refuses them as an accountable owner.
      const { rows } = await db.query(`select r1_draft_membership_can_own($1,$2) as ok`, [CO_A, mem.get("no-capability")!]);
      expect(rows[0].ok).toBe(false);
    });

    it("writes nothing at all — resolution is a read", async () => {
      const before = await db.query(`select count(*)::int as n from management_items where company_id = $1`, [CO_A]);
      const rolesBefore = await db.query(`select count(*)::int as n from membership_roles where company_id = $1`, [CO_A]);
      resolveCandidates(request(), [await evidenceFor(db, CO_A, mem.get("alice")!, "2026-09-02")]);
      const after = await db.query(`select count(*)::int as n from management_items where company_id = $1`, [CO_A]);
      const rolesAfter = await db.query(`select count(*)::int as n from membership_roles where company_id = $1`, [CO_A]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(rolesAfter.rows[0].n).toBe(rolesBefore.rows[0].n);
    });
  });

  describe("no eligible candidate, end to end", () => {
    it("produces needs_routing that the DATABASE will actually accept", async () => {
      // Nobody holds a capability that exists nowhere in the seed.
      const all = await Promise.all(
        ["alice", "no-capability"].map((l) => evidenceFor(db, CO_A, mem.get(l)!, "2026-09-02")),
      );
      const r = resolveCandidates(request({ requiredCapability: "operations.nonexistent.capability" }), all);
      expect(r.outcome).toBe("needs_routing");

      const item = await seedItem(db, CO_A);
      await db.query(
        `update management_items
            set routing_reason = $2, routing_department = $3, routing_requested_at = now()
          where id = $1`,
        [item, r.routing!.detail, r.routing!.department],
      );
      await db.query(
        `select r1_draft_transition_item($1,'approved','needs_routing',$2,'system',$3,'[]'::jsonb)`,
        [item, mem.get("alice")!, r.routing!.detail],
      );
      const { rows } = await db.query(`select state, routing_reason from management_items where id = $1`, [item]);
      expect(rows[0].state).toBe("needs_routing");
      expect(rows[0].routing_reason).toContain("considered");
    });

    it("the DATABASE refuses an unrouted item with no reason — the fallback cannot be silent", async () => {
      const item = await seedItem(db, CO_A);
      // Through the RPC, because draft 010 refuses a direct state UPDATE before the CHECK is
      // ever reached. Both boundaries hold; this asserts the second one.
      await expect(
        db.query(
          `select r1_draft_transition_item($1,'approved','needs_routing',$2,'system',null,'[]'::jsonb)`,
          [item, mem.get("alice")!],
        ),
      ).rejects.toThrow(/management_items_routing_reason_ck|check constraint|routing/i);
    });

    it("a DIRECT state write is refused outright — the lifecycle stays RPC-only", async () => {
      const item = await seedItem(db, CO_A);
      await expect(
        db.query(`update management_items set state = 'assigned' where id = $1`, [item]),
      ).rejects.toThrow(/may only change through r1_draft_transition_item/i);
    });
  });

  describe("learning from real append-only history", () => {
    it("derives a signal from transitions written by real humans, and refuses self-verified ones", async () => {
      const worker = mem.get("alice")!;
      const kind = "operations.task_exception";

      const outcomes: OutcomeRecord[] = [];
      for (let i = 0; i < 3; i++) {
        const item = await seedItem(db, CO_A);
        const decider = [mem.get("bob")!, mem.get("no-capability")!, mem.get("suspended")!][i]!;
        await db.query(
          `insert into management_item_transitions (company_id, item_id, from_state, to_state, actor_id, actor_type, reason)
           values ($1,$2,'verifying','verified',$3,'user','confirmed by re-observation')`,
          [CO_A, item, decider],
        );
        const { rows } = await db.query(
          `select id, actor_id, actor_type, created_at from management_item_transitions
            where item_id = $1 and to_state = 'verified'`,
          [item],
        );
        outcomes.push({
          outcomeId: rows[0].id, companyId: CO_A, membershipId: worker, taskKind: kind, role: "assignee", itemId: item,
          outcome: "verified", deciderId: rows[0].actor_id, deciderType: rows[0].actor_type,
          occurredAt: new Date(rows[0].created_at).toISOString(),
          businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition",
        });
      }

      const signal = buildSignal(outcomes, worker, kind, CO_A, new Date());
      expect(signal).not.toBeNull();
      expect(signal!.confirmedOutcomeCount).toBe(3);
      expect(signal!.distinctDeciderCount).toBe(3);

      // Self-verified history yields nothing, however much of it there is.
      const selfMade = outcomes.map((o) => ({ ...o, deciderId: worker }));
      expect(buildSignal(selfMade, worker, kind, CO_A, new Date())).toBeNull();
    });

    it("cannot read another company's history", async () => {
      const worker = mem.get("alice")!;
      const foreignHistory: OutcomeRecord[] = [1, 2, 3].map((i) => ({
        outcomeId: randomUUID(), companyId: CO_B, membershipId: worker,
        taskKind: "operations.task_exception", role: "assignee", itemId: randomUUID(), outcome: "verified",
        deciderId: `d${i}`, deciderType: "user", occurredAt: new Date().toISOString(),
        businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition",
      }));
      expect(buildSignal(foreignHistory, worker, "operations.task_exception", CO_A, new Date())).toBeNull();
    });

    it("the transitions history it learns from is APPEND-ONLY at the database", async () => {
      const item = await seedItem(db, CO_A);
      await db.query(
        `insert into management_item_transitions (company_id, item_id, from_state, to_state, actor_id, actor_type)
         values ($1,$2,null,'observed',$3,'system')`,
        [CO_A, item, mem.get("alice")!],
      );
      await expect(
        db.query(`update management_item_transitions set to_state = 'verified' where item_id = $1`, [item]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query(`delete from management_item_transitions where item_id = $1`, [item]),
      ).rejects.toThrow(/append-only/);
    });
  });
});
