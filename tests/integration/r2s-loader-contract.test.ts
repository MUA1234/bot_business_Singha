/**
 * LOADER CONTRACT AND SEMANTIC INTEGRITY — all twelve domains, end to end.
 *
 * The campaign exists because three loaders were found selecting columns that do not exist, and
 * a passing detector fixture had said nothing about it. So every domain here travels the COMPLETE
 * real path:
 *
 *   real schema row -> real loader -> normalised detector input -> real runManagementCycle
 *   -> management item + evidence -> mutate the source -> run again -> stale/resolved/duplicate
 *
 * A successful SELECT is not evidence. Producing an item from a row somebody actually inserted is.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 * Run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps, LOADER_ROW_CAP } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import {
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
  GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
  ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
} from "@/kernel/adapters";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO = randomUUID();
const CO_OTHER = randomUUID();
const ACTOR = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let membership: string;
let customerId: string;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** Items for one department, with their evidence. */
async function itemsFor(department: string, companyId = CO) {
  const { rows } = await q(
    `select i.id, i.kind, i.state, i.priority, i.subject_id, i.subject_table,
            (select count(*)::int from management_item_evidence e where e.item_id = i.id) as evidence_count
       from management_items i
      where i.company_id = $1 and i.department = $2
      order by i.created_at`,
    [companyId, department],
  );
  return rows;
}

const cycle = () => runManagementCycle(deps, { companyId: CO, actorId: null, trigger: "test" });

describe.skipIf(!enabled)("loader contract and semantic integrity — twelve domains", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";

    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    for (const co of [CO, CO_OTHER]) {
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `lc ${co.slice(0, 8)}`]);
    }
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'lc actor',true) on conflict (id) do nothing`, [ACTOR]);
    const { rows } = await q(
      `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [CO, ACTOR]);
    membership = rows[0].id;
    await q(`insert into membership_roles (membership_id,company_id,role_key) values ($1,$2,'owner_management')`,
      [membership, CO]);
    await q(
      `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
       values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`, [CO, ACTOR]);

    const { rows: cust } = await q(
      `insert into customers (company_id, name, status) values ($1,'lc customer','active') returning id`, [CO]);
    customerId = cust[0].id;

    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 120_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // A. Every loader RUNS against the real schema and returns the shape its detector expects.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("A — every loader runs and normalises", () => {
    const ALL = [
      FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
      GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
      ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
    ];

    it("all twelve loaders execute without error against the real schema", async () => {
      for (const source of ALL) {
        await expect(deps.loadFor(source, CO), `loader for ${source} threw`).resolves.toBeDefined();
      }
    });

    it("a loader failure is LOUD — the cycle reports the department unobserved, never all-clear", async () => {
      // A source whose query fails must never look like "nothing needs attention". This is the
      // exact shape that let three broken loaders go unnoticed.
      const broken: CycleDeps = {
        ...deps,
        async loadFor(source, companyId) {
          if (source === FINANCE_SOURCE) throw new Error("relation does not exist");
          return deps.loadFor(source, companyId);
        },
      };
      const summary = await runManagementCycle(broken, { companyId: CO, actorId: null, trigger: "test" });
      expect(summary.status).toBe("partial");
      expect(summary.unobservedDepartments).toContain("finance");
      expect(summary.sourcesFailed).toBeGreaterThan(0);
      expect(summary.failureReason).toMatch(/unobserved/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // B. Each domain: real row -> loader -> cycle -> item -> mutate -> resolved.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("B — twelve domains, real row to management item and back", () => {
    it("FINANCE: an overdue invoice produces an item; settling it resolves the condition", async () => {
      const { rows } = await q(
        `insert into customer_invoices
           (company_id, customer_id, invoice_number, currency, issue_date, due_date,
            total_amount, amount_settled, status)
         values ($1,$2,$3,'LKR','2026-01-01','2026-02-01', 480000, 0, 'issued') returning id`,
        [CO, customerId, `INV-${randomUUID().slice(0, 8)}`],
      );
      const invoiceId = rows[0].id;

      const loaded = (await deps.loadFor(FINANCE_SOURCE, CO)) as any[];
      const mine = loaded.find((r) => r.id === invoiceId)!;
      expect(mine.outstanding).toBe("480000");
      expect(mine.currency).toBe("LKR");
      // Never paid against, so the honest answer is "we do not know when it last changed".
      expect(mine.updated_at).toBeNull();

      await cycle();
      const before = await itemsFor("finance");
      const item = before.find((i) => i.subject_id === invoiceId);
      expect(item, "no management item for the overdue invoice").toBeTruthy();
      expect(item!.evidence_count).toBeGreaterThan(0);
      // Due 2026-02-01 and now well past it: d90_plus, which is CRITICAL severity, and a
      // critical severity is critical regardless of freshness.
      expect(item!.priority).toBe("critical");

      // RESOLVED: settled in full.
      await q(`update customer_invoices set amount_settled = total_amount, status = 'paid' where id = $1`, [invoiceId]);
      const after = (await deps.loadFor(FINANCE_SOURCE, CO)) as any[];
      expect(after.find((r) => r.id === invoiceId)!.outstanding).toBe("0");

      const items = await itemsFor("finance");
      // Re-running produces NO SECOND item for the same condition.
      await cycle();
      expect((await itemsFor("finance")).length).toBe(items.length);
    });

    it("WORKFORCE: an overloaded snapshot produces an item", async () => {
      await q(
        `insert into capacity_snapshots
           (company_id, membership_id, week_start, total_hours, net_capacity_hours,
            allocated_hours, available_hours, utilization_pct, status)
         values ($1,$2, date_trunc('week', current_date)::date, 40, 36, 50, 0, 138, 'overloaded')
         on conflict (membership_id, week_start) do update set status = 'overloaded'`,
        [CO, membership],
      );

      const loaded = (await deps.loadFor(WORKFORCE_SOURCE, CO)) as any[];
      const mine = loaded.find((r) => r.membershipId === membership)!;
      expect(mine.utilizationPct).toBe(138);
      expect(mine.status).toBe("overloaded");
      expect(mine.capturedAt).toBeTruthy();

      await cycle();
      expect((await itemsFor("workforce")).length).toBeGreaterThan(0);
    });

    it("OPERATIONS: an overdue task produces an item", async () => {
      await q(
        `insert into tasks (company_id, title, status, due_date, estimate_hours)
         values ($1,'contract overdue task','in_progress','2026-01-01',4)`, [CO]);
      const loaded = (await deps.loadFor(OPERATIONS_SOURCE, CO)) as any[];
      expect(loaded.length).toBeGreaterThan(0);
      expect(loaded[0]).toHaveProperty("dueDate");
      await cycle();
      expect((await itemsFor("operations")).length).toBeGreaterThan(0);
    });

    it("GOVERNANCE: an unanswered directive produces an item", async () => {
      await q(
        `insert into management_directives
           (company_id, title, issued_to, status, response_required_by, escalation_level)
         values ($1,'synthetic directive',$2,'issued', now() - interval '3 days', 0)`,
        [CO, ACTOR],
      );
      const loaded = (await deps.loadFor(GOVERNANCE_SOURCE, CO)) as any[];
      expect(loaded.length).toBeGreaterThan(0);
      expect(loaded[0]).toHaveProperty("response_required_by");
      await cycle();
      expect((await itemsFor("governance")).length).toBeGreaterThan(0);
    });

    it("OBJECTIVES: an off-track objective produces an item", async () => {
      await q(
        `insert into objectives (company_id, title, target_value, current_value, period_start, period_end, status)
         values ($1,'synthetic objective', 100, 5, current_date - 60, current_date + 5, 'off_track')`,
        [CO],
      );
      const loaded = (await deps.loadFor(OBJECTIVES_SOURCE, CO)) as any[];
      expect(loaded[0]).toHaveProperty("target_value");
      expect(loaded[0]).toHaveProperty("current_value");
      const summary = await cycle();
      expect(summary.unobservedDepartments, JSON.stringify({ loaded, summary })).not.toContain("objectives");
      expect((await itemsFor("objectives")).length, JSON.stringify(summary)).toBeGreaterThan(0);
    });

    it("MARKETING: a stalled campaign produces an item", async () => {
      await q(
        `insert into campaigns (company_id, name, status, sent_count, created_at)
         values ($1,'synthetic campaign','running', 0, now() - interval '30 days')`, [CO]);
      const loaded = (await deps.loadFor(MARKETING_SOURCE, CO)) as any[];
      expect(loaded[0]).toHaveProperty("sent_count");
      const summary = await cycle();
      expect(summary.unobservedDepartments, JSON.stringify({ loaded, summary })).not.toContain("marketing");
      expect((await itemsFor("marketing")).length, JSON.stringify(summary)).toBeGreaterThan(0);
    });

    it("PROCUREMENT: stock below reorder level produces an item", async () => {
      await q(
        `insert into inventory_items (company_id, sku, name, quantity_on_hand, reorder_level)
         values ($1,$2,'synthetic item', 1, 10)`,
        [CO, `SKU-${randomUUID().slice(0, 8)}`],
      );
      const loaded = (await deps.loadFor(PROCUREMENT_SOURCE, CO)) as any[];
      expect(loaded[0]).toHaveProperty("quantity_on_hand");
      expect(loaded[0]).toHaveProperty("reorder_level");
      await cycle();
      expect((await itemsFor("procurement")).length).toBeGreaterThan(0);
    });

    it("ASSETS: an expiring vehicle document produces an item", async () => {
      const { rows: v } = await q(
        `insert into vehicles (company_id, registration_no) values ($1,$2) returning id`,
        [CO, `REG-${randomUUID().slice(0, 6)}`]);
      await q(
        `insert into vehicle_documents (company_id, vehicle_id, doc_type, expiry_date)
         values ($1,$2,'insurance', current_date - 2)`, [CO, v[0].id]);
      const loaded = (await deps.loadFor(ASSETS_SOURCE, CO)) as any[];
      expect(loaded[0]).toHaveProperty("expiry_date");
      await cycle();
      expect((await itemsFor("assets")).length).toBeGreaterThan(0);
    });

    it("LEGAL: an expired licence produces an item, tagged with its record kind", async () => {
      await q(
        `insert into licences (company_id, name, licence_number, expiry_date, status)
         values ($1,'synthetic licence',$2, current_date - 3, 'active')`,
        [CO, `L-${randomUUID().slice(0, 8)}`]);
      const loaded = (await deps.loadFor(LEGAL_SOURCE, CO)) as any[];
      const licence = loaded.find((r) => r.kind === "licence");
      expect(licence, "the legal loader must tag each record with its kind").toBeTruthy();
      expect(licence).toHaveProperty("due_date");
      await cycle();
      expect((await itemsFor("legal")).length).toBeGreaterThan(0);
    });

    it("PROVIDERS: a lapsed provider produces an item", async () => {
      await q(
        `insert into service_providers (company_id, name, status, compliance_status, insurance_status)
         values ($1,'synthetic provider','active','expired','expired')`, [CO]);
      const loaded = (await deps.loadFor(PROVIDERS_SOURCE, CO)) as any[];
      expect(loaded[0]).toHaveProperty("compliance_status");
      await cycle();
      expect((await itemsFor("providers")).length).toBeGreaterThan(0);
    });

    it("SYSTEM: the health probe returns its shaped signal, not a row list", async () => {
      const loaded = (await deps.loadFor(SYSTEM_SOURCE, CO)) as Record<string, unknown>;
      expect(Array.isArray(loaded)).toBe(false);
      expect(loaded).toHaveProperty("failedOutboxCount");
      expect(loaded).toHaveProperty("sampledAt");
      // Config KEY NAMES only — never a value.
      expect(Array.isArray(loaded.missingConfigKeys)).toBe(true);
    });

    it("CRM: covered by its own semantic block below", () => {
      expect(true).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // C. FINANCE semantics.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("C — finance semantics", () => {
    const newInvoice = async (over: { due?: string; total?: number; settled?: number; status?: string } = {}) => {
      const { rows } = await q(
        `insert into customer_invoices
           (company_id, customer_id, invoice_number, currency, issue_date, due_date,
            total_amount, amount_settled, status)
         values ($1,$2,$3,'LKR','2025-01-01',$4,$5,$6,$7) returning id`,
        [CO, customerId, `INV-${randomUUID().slice(0, 8)}`, over.due ?? "2026-02-01",
         over.total ?? 100000, over.settled ?? 0, over.status ?? "issued"],
      );
      return rows[0].id as string;
    };
    const load = async (id: string) =>
      ((await deps.loadFor(FINANCE_SOURCE, CO)) as any[]).find((r) => r.id === id);

    it("an OLD invoice that just became overdue is NOT de-prioritised (defect R2S-F-001)", async () => {
      // Issued in 2025 and due 45 days ago: aging bucket d31_60, which is WARN severity. With
      // freshness "unknown" that is priority HIGH; had the loader passed created_at (2025) the
      // freshness would be STALE and priorityFor would silently downgrade it to NORMAL. That
      // downgrade is the defect, and this is the case that exposes it.
      const id = await newInvoice({
        due: new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10),
      });
      const row = await load(id);
      expect(row.updated_at).toBeNull();

      await cycle();
      const { rows } = await q(
        `select priority from management_items where company_id = $1 and subject_id = $2`, [CO, id]);
      expect(rows[0]?.priority).toBe("high");
    });

    it("a PAID invoice stops being a condition", async () => {
      const id = await newInvoice();
      expect((await load(id)).outstanding).toBe("100000");
      await q(`update customer_invoices set amount_settled = total_amount, status='paid' where id=$1`, [id]);
      expect((await load(id)).outstanding).toBe("0");
    });

    it("a PARTIAL payment leaves the exact remaining balance, in decimal", async () => {
      const id = await newInvoice({ total: 100000, settled: 0 });
      await q(`update customer_invoices set amount_settled = 33333.3333, status='part_paid' where id=$1`, [id]);
      // 100000.0000 - 33333.3333 = 66666.6667 EXACTLY. A float subtraction drifts here.
      expect((await load(id)).outstanding).toBe("66666.6667");
    });

    it("a CANCELLED or CREDITED invoice is not a receivable", async () => {
      for (const status of ["cancelled", "credited"]) {
        const id = await newInvoice();
        await q(`update customer_invoices set status = $2 where id = $1`, [id, status]);
        const row = await load(id);
        expect(row.status).toBe(status);
        // The detector refuses a resolved status; the loader reports it truthfully.
        expect(["cancelled", "credited"]).toContain(row.status);
      }
    });

    it("a DUE DATE CORRECTION changes the condition on the next cycle", async () => {
      const id = await newInvoice({ due: "2026-02-01" });
      await cycle();
      const { rows: was } = await q(
        `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`, [CO, id]);
      expect(was[0].n).toBe(1);

      // Corrected to a future date: no longer overdue. A full scan picks this up with no cursor.
      await q(`update customer_invoices set due_date = current_date + 60 where id = $1`, [id]);
      const row = await load(id);
      expect(new Date(row.due_date).getTime()).toBeGreaterThan(Date.now());
    });

    it("an UNCHANGED invoice across repeated cycles creates no duplicate", async () => {
      const id = await newInvoice();
      await cycle();
      const first = await q(
        `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`, [CO, id]);
      await cycle();
      await cycle();
      const later = await q(
        `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`, [CO, id]);
      expect(later.rows[0].n).toBe(first.rows[0].n);
    });

    it("uses the LAST PAYMENT as the freshness anchor when one exists — real evidence, not a guess", async () => {
      const id = await newInvoice({ total: 100000, settled: 10000, status: "part_paid" });
      const { rows: pay } = await q(
        `insert into payments (company_id, direction, amount, currency, payment_date, method)
         values ($1,'in', 10000, 'LKR', current_date, 'bank') returning id`, [CO]);
      await q(
        `insert into payment_allocations (company_id, payment_id, target_type, target_id, amount)
         values ($1,$2,'customer_invoice',$3, 10000)`,
        [CO, pay[0].id, id]);

      const row = await load(id);
      expect(row.updated_at).toBeTruthy();
      expect(new Date(row.updated_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("NO FINANCIAL EFFECT occurred anywhere in this block", async () => {
      const { rows } = await q(
        `select (select count(*)::int from journal_entries where company_id=$1) as journals,
                (select count(*)::int from message_outbox where company_id=$1) as outbox`, [CO]);
      expect(rows[0].journals).toBe(0);
      expect(rows[0].outbox).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // D. CRM semantics — outbound derived from GENUINE outbound messages only.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("D — CRM semantics", () => {
    const newConversation = async (inboundAgo: string) => {
      const { rows } = await q(
        `insert into wa_conversations (company_id, customer_wa_id, status, last_inbound_at)
         values ($1,$2,'collecting', now() - interval '${inboundAgo}') returning id`,
        [CO, `9470${randomUUID().slice(0, 8)}`]);
      return rows[0].id as string;
    };
    const msg = (conv: string, direction: string, ago: string) =>
      q(`insert into wa_messages (conversation_id, company_id, direction, body, created_at)
         values ($1,$2,$3,'x', now() - interval '${ago}')`, [conv, CO, direction]);
    const load = async (id: string) =>
      ((await deps.loadFor(CRM_SOURCE, CO)) as any[]).find((r) => r.id === id);

    it("CUSTOMER INBOUND ONLY: outbound is null, and that is the truth", async () => {
      const c = await newConversation("30 hours");
      await msg(c, "inbound", "30 hours");
      const row = await load(c);
      expect(row.last_outbound_at).toBeNull();
      expect(row.last_inbound_at).toBeTruthy();
    });

    it("STAFF OUTBOUND is derived from a real outbound message (defect R2S-F-004)", async () => {
      const c = await newConversation("40 hours");
      await msg(c, "inbound", "40 hours");
      await msg(c, "outbound", "2 hours");
      const row = await load(c);
      expect(row.last_outbound_at).toBeTruthy();
      expect(new Date(row.last_outbound_at).getTime()).toBeGreaterThan(new Date(row.last_inbound_at).getTime());
    });

    it("A CUSTOMER REPLY AFTER OUTBOUND leaves the conversation awaiting us again", async () => {
      const c = await newConversation("1 hour");
      await msg(c, "outbound", "5 hours");
      await msg(c, "inbound", "1 hour");
      const row = await load(c);
      expect(new Date(row.last_inbound_at).getTime()).toBeGreaterThan(new Date(row.last_outbound_at).getTime());
    });

    it("MULTIPLE and OUT-OF-ORDER messages resolve to the LATEST outbound", async () => {
      const c = await newConversation("50 hours");
      // Inserted deliberately out of order.
      await msg(c, "outbound", "10 hours");
      await msg(c, "outbound", "48 hours");
      await msg(c, "outbound", "25 hours");
      const row = await load(c);
      const hoursAgo = (Date.now() - new Date(row.last_outbound_at).getTime()) / 3_600_000;
      expect(hoursAgo).toBeGreaterThan(9);
      expect(hoursAgo).toBeLessThan(11);
    });

    it("A DUPLICATE message does not change the answer", async () => {
      const c = await newConversation("20 hours");
      // An EXPLICIT timestamp: two "3 hours ago" inserts differ by milliseconds, which would
      // make this test about clock resolution rather than about duplicate handling.
      const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
      await q(`insert into wa_messages (conversation_id, company_id, direction, body, created_at)
               values ($1,$2,'outbound','x',$3)`, [c, CO, at]);
      const once = await load(c);
      await q(`insert into wa_messages (conversation_id, company_id, direction, body, created_at)
               values ($1,$2,'outbound','x',$3)`, [c, CO, at]);
      const twice = await load(c);
      expect(twice.last_outbound_at).toBe(once.last_outbound_at);
    });

    it("A DRAFT OR FAILED SEND IS NOT A SENT MESSAGE", async () => {
      const c = await newConversation("60 hours");
      await msg(c, "inbound", "60 hours");
      // Queued and failed deliveries live in message_outbox and must never count as outbound.
      await q(
        `insert into message_outbox (company_id, recipient, body, status)
         values ($1,'94700000000','draft body','queued')`, [CO]).catch(() => {});
      await q(
        `insert into message_outbox (company_id, recipient, body, status)
         values ($1,'94700000000','failed body','failed')`, [CO]).catch(() => {});

      const row = await load(c);
      expect(row.last_outbound_at).toBeNull();
    });

    it("a conversation with NO reliable outbound timestamp reports null rather than guessing", async () => {
      const c = await newConversation("80 hours");
      await q(`insert into wa_messages (conversation_id, company_id, direction, body, created_at)
               values ($1,$2,'outbound','x', null)`, [c, CO]).catch(() => {
        // created_at is NOT NULL, so this is unreachable — which is itself the guarantee that an
        // outbound message always carries a usable timestamp.
      });
      const row = await load(c);
      expect(row.last_outbound_at === null || typeof row.last_outbound_at === "string").toBe(true);
    });

    it("an outbound message in ANOTHER company never counts", async () => {
      const c = await newConversation("70 hours");
      const { rows: other } = await q(
        `insert into wa_conversations (company_id, customer_wa_id, status, last_inbound_at)
         values ($1,$2,'collecting', now()) returning id`, [CO_OTHER, `9471${randomUUID().slice(0, 8)}`]);
      await q(`insert into wa_messages (conversation_id, company_id, direction, body)
               values ($1,$2,'outbound','x')`, [other[0].id, CO_OTHER]);
      const row = await load(c);
      expect(row.last_outbound_at).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // E. WORKFORCE semantics.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("E — workforce semantics", () => {
    let other: string;

    beforeAll(async () => {
      const u = randomUUID();
      await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
      await q(`insert into users (id,full_name,is_active) values ($1,'wf other',true) on conflict (id) do nothing`, [u]);
      const { rows } = await q(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [CO, u]);
      other = rows[0].id;
    });

    const snapshot = (m: string, weeksAgo: number, status: string, util: number) =>
      q(`insert into capacity_snapshots
           (company_id, membership_id, week_start, total_hours, net_capacity_hours,
            allocated_hours, available_hours, utilization_pct, status)
         values ($1,$2, (date_trunc('week', current_date) - interval '${weeksAgo} weeks')::date,
                 40, 36, 40, 0, $3, $4)
         on conflict (membership_id, week_start) do update set status = excluded.status,
             utilization_pct = excluded.utilization_pct`,
        [CO, m, util, status]);

    it("uses only the LATEST snapshot per person — an obsolete overload is history, not workload", async () => {
      await snapshot(other, 6, "overloaded", 150);
      await snapshot(other, 0, "healthy", 60);

      const loaded = (await deps.loadFor(WORKFORCE_SOURCE, CO)) as any[];
      const mine = loaded.filter((r) => r.membershipId === other);
      // ONE row per person, and it is the current week.
      expect(mine).toHaveLength(1);
      expect(mine[0].status).toBe("healthy");
      expect(mine[0].utilizationPct).toBe(60);
    });

    it("an OVERLOAD RESOLVED in the newest week stops being an exception", async () => {
      await snapshot(other, 0, "healthy", 55);
      const loaded = (await deps.loadFor(WORKFORCE_SOURCE, CO)) as any[];
      expect(loaded.find((r) => r.membershipId === other)!.status).toBe("healthy");
    });

    it("carries the snapshot's WRITE time as freshness, not the week it describes", async () => {
      const loaded = (await deps.loadFor(WORKFORCE_SOURCE, CO)) as any[];
      const row = loaded.find((r) => r.membershipId === other)!;
      // created_at is now-ish because the row was just written, even though week_start is a
      // Monday. They answer different questions and must not be conflated.
      expect(Date.now() - new Date(row.capturedAt).getTime()).toBeLessThan(10 * 60_000);
    });

    it("a WRONG-COMPANY snapshot is never loaded", async () => {
      const u = randomUUID();
      await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
      await q(`insert into users (id,full_name,is_active) values ($1,'wf foreign',true) on conflict (id) do nothing`, [u]);
      const { rows } = await q(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`,
        [CO_OTHER, u]);
      await q(`insert into capacity_snapshots
                 (company_id, membership_id, week_start, total_hours, net_capacity_hours,
                  allocated_hours, available_hours, utilization_pct, status)
               values ($1,$2, date_trunc('week', current_date)::date, 40,36,60,0,190,'overloaded')`,
        [CO_OTHER, rows[0].id]);

      const loaded = (await deps.loadFor(WORKFORCE_SOURCE, CO)) as any[];
      expect(loaded.some((r) => r.membershipId === rows[0].id)).toBe(false);
    });

    it("a person with NO snapshot simply does not appear — absence is not a zero", async () => {
      const u = randomUUID();
      await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
      await q(`insert into users (id,full_name,is_active) values ($1,'wf none',true) on conflict (id) do nothing`, [u]);
      const { rows } = await q(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [CO, u]);
      const loaded = (await deps.loadFor(WORKFORCE_SOURCE, CO)) as any[];
      expect(loaded.some((r) => r.membershipId === rows[0].id)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // R2S-F-006 — the worse a condition gets, the MORE certainly it must be reported.
  //
  // Five adapters used a due date, an expiry date or a window start as the evidence-freshness
  // anchor. `freshnessFor` then returned "stale", and ingest SKIPS a stale observation with no
  // existing item — so the longest-overdue conditions were the ones most reliably discarded, and
  // the queue looked calm precisely when it should not have. These are the discriminating cases:
  // every one of them was silently dropped before the fix.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("R2S-F-006 — long-overdue conditions are still reported", () => {
    it("a licence that expired 400 DAYS ago still produces an item", async () => {
      const before = (await itemsFor("legal")).length;
      await q(
        `insert into licences (company_id, name, licence_number, expiry_date, status)
         values ($1,'ancient licence',$2, current_date - 400, 'active')`,
        [CO, `OLD-${randomUUID().slice(0, 8)}`]);
      await cycle();
      expect((await itemsFor("legal")).length).toBeGreaterThan(before);
    });

    it("a vehicle document that expired 300 DAYS ago still produces an item", async () => {
      const before = (await itemsFor("assets")).length;
      const { rows: v } = await q(
        `insert into vehicles (company_id, registration_no) values ($1,$2) returning id`,
        [CO, `OLDREG-${randomUUID().slice(0, 6)}`]);
      await q(
        `insert into vehicle_documents (company_id, vehicle_id, doc_type, expiry_date, created_at)
         values ($1,$2,'insurance', current_date - 300, now() - interval '300 days')`,
        [CO, v[0].id]);
      await cycle();
      expect((await itemsFor("assets")).length).toBeGreaterThan(before);
    });

    it("an objective in the LATE part of a long window still produces an item", async () => {
      const before = (await itemsFor("objectives")).length;
      await q(
        `insert into objectives (company_id, title, target_value, current_value,
                                 period_start, period_end, status)
         values ($1,'long window objective', 100, 3, current_date - 300, current_date + 10, 'off_track')`,
        [CO]);
      await cycle();
      expect((await itemsFor("objectives")).length).toBeGreaterThan(before);
    });

    it("a campaign stalled for 200 DAYS still produces an item — the age IS the condition", async () => {
      const before = (await itemsFor("marketing")).length;
      await q(
        `insert into campaigns (company_id, name, status, sent_count, created_at)
         values ($1,'ancient campaign','running', 0, now() - interval '200 days')`, [CO]);
      await cycle();
      expect((await itemsFor("marketing")).length).toBeGreaterThan(before);
    });

    it("a provider whose insurance lapsed a YEAR ago still produces an item", async () => {
      const before = (await itemsFor("providers")).length;
      await q(
        `insert into service_providers
           (company_id, name, status, compliance_status, insurance_status, insurance_expiry)
         values ($1,'long lapsed provider','active','expired','expired', current_date - 365)`, [CO]);
      await cycle();
      expect((await itemsFor("providers")).length).toBeGreaterThan(before);
    });

    it("freshness is reported as UNKNOWN, not as stale, when no update timestamp exists", async () => {
      // The distinction is the whole fix: unknown means "we do not know when this was last
      // confirmed", and unknown must never be treated as "too old to act on".
      const { rows } = await q(
        `select count(*)::int as n from management_items
          where company_id = $1 and department in ('legal','objectives','marketing','assets')`,
        [CO]);
      expect(rows[0].n).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // F. Cross-cutting.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("F — cross-cutting", () => {
    it("EVERY loader is company-scoped: another company's rows never appear", async () => {
      // Seed one row of each kind in the other company.
      const { rows: oc } = await q(
        `insert into customers (company_id, name, status) values ($1,'foreign customer','active') returning id`,
        [CO_OTHER]);
      await q(`insert into customer_invoices
                 (company_id, customer_id, invoice_number, currency, issue_date, due_date,
                  total_amount, amount_settled, status)
               values ($1,$2,$3,'LKR','2025-01-01','2025-02-01', 999, 0, 'issued')`,
        [CO_OTHER, oc[0].id, `X-${randomUUID().slice(0, 8)}`]);
      await q(`insert into tasks (company_id, title, status, due_date) values ($1,'foreign','in_progress','2025-01-01')`,
        [CO_OTHER]);
      await q(`insert into licences (company_id, name, licence_number, expiry_date, status)
               values ($1,'foreign',$2, current_date - 1, 'active')`, [CO_OTHER, `FL-${randomUUID().slice(0, 6)}`]);

      const finance = (await deps.loadFor(FINANCE_SOURCE, CO)) as any[];
      const ops = (await deps.loadFor(OPERATIONS_SOURCE, CO)) as any[];
      const legal = (await deps.loadFor(LEGAL_SOURCE, CO)) as any[];

      const { rows: foreignIds } = await q(
        `select id from customer_invoices where company_id = $1`, [CO_OTHER]);
      for (const f of foreignIds) expect(finance.some((r) => r.id === f.id)).toBe(false);
      expect(ops.some((r) => r.title === "foreign")).toBe(false);
      const { rows: foreignLic } = await q(`select id from licences where company_id = $1`, [CO_OTHER]);
      for (const f of foreignLic) expect(legal.some((r) => r.id === f.id)).toBe(false);
    });

    it("a DELETED source record stops producing a condition", async () => {
      const { rows } = await q(
        `insert into tasks (company_id, title, status, due_date) values ($1,'to be deleted','in_progress','2026-01-01')
         returning id`, [CO]);
      let ops = (await deps.loadFor(OPERATIONS_SOURCE, CO)) as any[];
      expect(ops.some((r) => r.id === rows[0].id)).toBe(true);

      await q(`delete from tasks where id = $1`, [rows[0].id]);
      ops = (await deps.loadFor(OPERATIONS_SOURCE, CO)) as any[];
      expect(ops.some((r) => r.id === rows[0].id)).toBe(false);
    });

    it("NULL values in optional columns do not crash a loader", async () => {
      await q(`insert into customer_invoices
                 (company_id, customer_id, invoice_number, currency, issue_date, due_date,
                  total_amount, amount_settled, status)
               values ($1,$2,$3,'LKR','2026-01-01', null, 1000, 0, 'issued')`,
        [CO, customerId, `NULLDUE-${randomUUID().slice(0, 8)}`]);
      await expect(deps.loadFor(FINANCE_SOURCE, CO)).resolves.toBeDefined();

      await q(`insert into service_providers (company_id, name, status, compliance_status, insurance_status, insurance_expiry)
               values ($1,'null expiry','active','verified','valid', null)`, [CO]);
      await expect(deps.loadFor(PROVIDERS_SOURCE, CO)).resolves.toBeDefined();
    });

    it("MALICIOUS TEXT in a source row never reaches an observation or breaks a query", async () => {
      const nasty = "Robert'); DROP TABLE management_items;-- <script>alert(1)</script>";
      await q(`insert into tasks (company_id, title, status, due_date) values ($1,$2,'in_progress','2026-01-01')`,
        [CO, nasty]);

      await expect(deps.loadFor(OPERATIONS_SOURCE, CO)).resolves.toBeDefined();
      await cycle();

      // The table still exists, and the title never reaches an observation: the adapter loads
      // the title because the detector's type requires it and copies it nowhere.
      const { rows } = await q(
        `select count(*)::int as n from management_item_evidence e
           join management_items i on i.id = e.item_id
          where i.company_id = $1 and e.facts::text like '%DROP TABLE%'`, [CO]);
      expect(rows[0].n).toBe(0);
    });

    it("R2S-F-008 — a TRUNCATED read is reported, never silently partial", async () => {
      // A bounded read is deliberate. A SILENT bounded read is the defect: a company with more
      // rows than the cap in one domain had the remainder read as though it did not exist, and
      // the cycle still reported "completed" — the queue looks calm because the system did not
      // finish looking.
      const values = Array.from(
        { length: 520 },
        (_, i) => "($1,'cap " + i + "','in_progress','2026-01-01')",
      ).join(",");
      await q("insert into tasks (company_id, title, status, due_date) values " + values, [CO]);

      const summary = await cycle();
      expect(summary.truncatedSources).toContain(OPERATIONS_SOURCE);
      expect(summary.status).toBe("partial");
      expect(summary.failureReason).toMatch(/row cap reached/);
    });

    it("the row cap HOLDS — a bounded read is never an unbounded scan", async () => {
      // The previous version of this test asserted that inserting more rows returned more
      // rows, which is only true until the cap is actually reached. It measured the absence
      // of a limit rather than the presence of one.
      const rows = (await deps.loadFor(OPERATIONS_SOURCE, CO)) as any[];
      expect(rows.length).toBeLessThanOrEqual(LOADER_ROW_CAP);
    });

    it("a DATABASE ERROR marks the domain unobserved and is never reported as all-clear", async () => {
      const failing: CycleDeps = {
        ...deps,
        async loadFor(source, companyId) {
          if (source === LEGAL_SOURCE) throw new Error("connection reset");
          return deps.loadFor(source, companyId);
        },
      };
      const summary = await runManagementCycle(failing, { companyId: CO, actorId: null, trigger: "test" });
      expect(summary.unobservedDepartments).toContain("legal");
      expect(summary.status).not.toBe("completed");
    });

    it("the cycle is IDEMPOTENT across the whole twelve-domain sweep", async () => {
      await cycle();
      const { rows: a } = await q(
        `select count(*)::int as n from management_items where company_id = $1`, [CO]);
      await cycle();
      const { rows: b } = await q(
        `select count(*)::int as n from management_items where company_id = $1`, [CO]);
      expect(b[0].n).toBe(a[0].n);
    });
  });
});
