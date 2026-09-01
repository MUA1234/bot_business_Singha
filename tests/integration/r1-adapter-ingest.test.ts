/**
 * R1 adapters → management items, on a live database (checkpoint 3).
 *
 * The pure adapter logic is proven in tests/kernel/adapters.test.ts. This file proves the
 * three things that can only be shown against a real database:
 *   * a COMPLETE audit chain from observation to management item to evidence to transition;
 *   * TRANSACTION ROLLBACK leaving no partial item;
 *   * REVOKED MEMBERSHIP producing truthful handling rather than silent reassignment.
 *
 * Requires the FULL schema: run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  detectFinanceObservations, detectWorkforceObservations, detectOperationsObservations,
  detectCrmObservations, detectSystemHealthObservations,
} from "@/kernel/adapters";
import { ingestObservation, type ExistingItem } from "@/kernel/ingest";
import type { Observation } from "@/kernel/observation";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO = randomUUID();
const USER = randomUUID();
const CORR = randomUUID();
const NOW = new Date("2026-09-02T09:00:00.000Z");

let db: pg.Client;
let membershipId: string;

/**
 * `suffix` makes each test's identity keys unique. The identity key is deliberately
 * INDEPENDENT of the correlation id — it is company + source + subject + window — so two
 * tests scanning the same fixture would otherwise collide on the dedupe constraint, which
 * is that constraint working correctly rather than a defect.
 */
function fiveObservations(companyId: string, correlationId = CORR, suffix = ""): Observation[] {
  const withSuffix = (o: Observation): Observation =>
    suffix ? { ...o, identityKey: `${o.identityKey}:${suffix}` } : o;
  return [
    ...detectFinanceObservations({
      companyId, correlationId, now: NOW,
      invoices: [{ id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
                   updated_at: "2026-09-01T00:00:00.000Z", status: "open" }],
    }),
    ...detectWorkforceObservations({
      companyId, correlationId, now: NOW,
      capacities: [{ membershipId: "mem-x", status: "overloaded", utilizationPct: 135,
                     snapshotId: "snap-1", capturedAt: "2026-09-01T00:00:00.000Z" }],
    }),
    ...detectOperationsObservations({
      companyId, correlationId, now: NOW,
      tasks: [{ id: "task-1", title: "t", status: "in_progress", dueDate: "2026-08-01",
                lastCheckInAt: "2026-09-01T00:00:00.000Z", estimateHours: 4,
                updatedAt: "2026-09-01T00:00:00.000Z" }],
    }),
    ...detectCrmObservations({
      companyId, correlationId, now: NOW,
      conversations: [{ id: "conv-1", last_inbound_at: "2026-09-01T09:00:00.000Z",
                        last_outbound_at: null, status: "open" }],
    }),
    ...detectSystemHealthObservations({
      companyId, correlationId, now: NOW,
      oldestPendingOutboxMinutes: 240, failedOutboxCount: 3,
      ledger: { imbalancedJournals: 1, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
      providerFailures: 4, missingConfigKeys: ["OPENAI_API_KEY"],
      sampledAt: "2026-09-02T08:55:00.000Z",
    }),
  ].map(withSuffix);
}

/** Persist one observation exactly as the kernel would: item + evidence + opening transition. */
async function persist(client: pg.Client, o: Observation): Promise<string> {
  const { rows } = await client.query(
    `insert into management_items
       (company_id, department, kind, subject_table, subject_id, identity_key, state,
        priority, confidence, required_authority, business_deadline, business_deadline_source)
     values ($1,$2,$3,$4,$5,$6,'observed',$7,$8,$9,$10,$11)
     returning id`,
    [o.companyId, o.department, o.kind, o.subjectRef.table, o.subjectRef.id, o.identityKey,
     o.priority, o.confidence, o.authorityClass,
     o.businessDeadline?.at ?? null, o.businessDeadline?.source ?? null],
  );
  const itemId = rows[0].id as string;

  for (const e of o.evidence) {
    await client.query(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,$3,$4,$5)`,
      [o.companyId, itemId, e.sourceTable, e.sourceId, JSON.stringify(e.facts)],
    );
  }
  await client.query(
    `insert into management_item_transitions
       (company_id, item_id, from_state, to_state, actor_type, reason, evidence)
     values ($1,$2,null,'observed','system',$3,$4)`,
    [o.companyId, itemId, `detected by ${o.observationSource}`,
     JSON.stringify(o.evidence.map((e) => ({ table: e.sourceTable, id: e.sourceId })))],
  );
  return itemId;
}

describe.skipIf(!enabled)("R1 adapters → management items (live)", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db.query(`insert into companies (id, name, base_currency) values ($1,'r1-adapters','LKR')
                      on conflict (id) do nothing`, [CO]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'adapter actor',true)
                      on conflict (id) do nothing`, [USER]);
    const { rows } = await db.query(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [CO, USER]);
    membershipId = rows[0].id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key)
                    values ($1,$2,'project_manager') on conflict do nothing`, [membershipId, CO]);
  }, 120_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
  });

  it("persists all five departments as management items in one company", async () => {
    const obs = fiveObservations(CO);
    expect(obs).toHaveLength(5);
    for (const o of obs) await persist(db, o);

    const { rows } = await db.query(
      `select department, count(*)::int as n from management_items where company_id=$1 group by department`, [CO]);
    expect(new Set(rows.map((r) => r.department)))
      .toEqual(new Set(["finance", "workforce", "operations", "crm", "system"]));
  });

  it("keeps a COMPLETE audit chain: observation → item → evidence → transition", async () => {
    const o = fiveObservations(CO, randomUUID(), "audit")[0]!;
    const itemId = await persist(db, o);

    const { rows: item } = await db.query(
      `select company_id, department, kind, subject_table, subject_id, identity_key, state,
              business_deadline_source
         from management_items where id=$1`, [itemId]);
    expect(item[0].department).toBe("finance");
    expect(item[0].subject_table).toBe("customer_invoices");
    expect(item[0].business_deadline_source).toBe("evidence");

    const { rows: ev } = await db.query(
      `select source_table, source_id, facts from management_item_evidence where item_id=$1`, [itemId]);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].source_table).toBe("customer_invoices");
    // The evidence points at the real row and carries only the safe summary.
    expect(JSON.stringify(ev[0].facts)).not.toContain("480000");

    const { rows: tr } = await db.query(
      `select from_state, to_state, actor_type, reason, evidence
         from management_item_transitions where item_id=$1 order by created_at`, [itemId]);
    expect(tr[0].from_state).toBeNull();
    expect(tr[0].to_state).toBe("observed");
    expect(tr[0].actor_type).toBe("system");
    expect(tr[0].reason).toContain("finance.receivable_overdue");
    // The opening transition records WHICH rows justified the item.
    expect(tr[0].evidence[0].table).toBe("customer_invoices");
  });

  it("DEDUPLICATES: re-running the same scan reuses the item instead of creating a second", async () => {
    const corr = randomUUID();
    const o = fiveObservations(CO, corr, "dedupe")[2]!; // operations
    await persist(db, o);

    const { rows: before } = await db.query(
      `select count(*)::int as n from management_items where identity_key=$1`, [o.identityKey]);
    expect(before[0].n).toBe(1);

    // The kernel consults ingest, which returns reuse/skip — and the database would refuse a
    // duplicate anyway. Both defences are asserted.
    const existing: ExistingItem = { id: "x", state: "observed", severity: o.severity, priority: o.priority, evidenceAt: o.evidenceAt };
    expect(ingestObservation(o, { companyId: CO }, existing).action).toBe("skip");

    await expect(persist(db, o)).rejects.toThrow(/duplicate key/i);

    const { rows: after } = await db.query(
      `select count(*)::int as n from management_items where identity_key=$1`, [o.identityKey]);
    expect(after[0].n).toBe(1);
  });

  it("TRANSACTION ROLLBACK leaves no partial item, evidence or transition", async () => {
    const o = fiveObservations(CO, randomUUID(), "rollback")[3]!; // crm
    let itemId = "";

    await db.query("begin");
    try {
      itemId = await persist(db, o);
      // Something later in the same unit of work fails.
      throw new Error("simulated downstream failure");
    } catch {
      await db.query("rollback");
    }

    const { rows: items } = await db.query(
      `select count(*)::int as n from management_items where identity_key=$1`, [o.identityKey]);
    expect(items[0].n).toBe(0);
    const { rows: ev } = await db.query(
      `select count(*)::int as n from management_item_evidence where item_id=$1`, [itemId]);
    expect(ev[0].n).toBe(0);
    const { rows: tr } = await db.query(
      `select count(*)::int as n from management_item_transitions where item_id=$1`, [itemId]);
    expect(tr[0].n).toBe(0);
  });

  it("REVOKED MEMBERSHIP: an assigned item is re-routed truthfully, never reassigned silently", async () => {
    const o = fiveObservations(CO, randomUUID(), "revoke")[2]!;
    const itemId = await persist(db, o);

    // Walk it to assigned with a real, authorised owner.
    for (const [f, t] of [["observed", "understood"], ["understood", "prioritised"],
                          ["prioritised", "recommended"], ["recommended", "awaiting_approval"],
                          ["awaiting_approval", "approved"]] as const) {
      await db.query(`select r1_draft_transition_item($1,$2,$3,$4,'user',null,'[]'::jsonb)`, [itemId, f, t, USER]);
    }
    await db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [itemId, membershipId]);
    const { rows: assigned } = await db.query(
      `select r1_draft_transition_item($1,'approved','assigned',$2,'user',null,'[]'::jsonb) as r`, [itemId, USER]);
    expect(assigned[0].r.result).toBe("transitioned");

    // Revoke the owner's membership and re-validate.
    await db.query(`update memberships set status='ended' where id=$1`, [membershipId]);
    const { rows: n } = await db.query(`select r1_draft_revalidate_owners($1) as n`, [CO]);
    expect(n[0].n).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      `select state, accountable_owner_id, routing_reason from management_items where id=$1`, [itemId]);
    expect(rows[0].state).toBe("needs_routing");
    expect(rows[0].accountable_owner_id).toBeNull();
    expect(rows[0].routing_reason).toMatch(/lost active authorised membership/i);

    await db.query(`update memberships set status='active' where id=$1`, [membershipId]);
  });

  it("correlation ties one sweep's items together for tracing", async () => {
    const corr = randomUUID();
    const obs = fiveObservations(CO, corr, corr);
    const ids: string[] = [];
    for (const o of obs) ids.push(await persist(db, o));

    const { rows } = await db.query(
      `select count(*)::int as n from management_item_transitions where item_id = any($1)`, [ids]);
    expect(rows[0].n).toBe(obs.length);
    // Every observation in one sweep shares the correlation id it was scanned under.
    expect(new Set(obs.map((o) => o.correlationId))).toEqual(new Set([corr]));
  });
});
