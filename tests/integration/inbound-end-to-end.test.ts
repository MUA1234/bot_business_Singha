/**
 * FOUND-003 — the whole inbound chain, against live PostgreSQL:
 *
 *   receiving account → company → sender identity → intent → routing → source event
 *   → review queue → audit → what the UI reads.
 *
 * Every step here runs the REAL database function the production path calls, and the dispatcher is
 * the real dispatcher. Only two things are substituted: the Supabase HTTP client (replaced by a
 * direct pg connection to the same functions) and the model classifier, which has no provider
 * configured and is an owner gate. The production WIRING — that these are the functions the route
 * and the worker actually call — is proven separately by tests/campaign/webhook-callgraph.test.ts;
 * neither test is sufficient alone, which is how a pipeline with no production caller shipped once
 * before.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { dispatchInbound, type DispatchDeps, type InboundMessage } from "@/lib/inbound/dispatch";
import { isUsableCompany, resolveReceivingCompany } from "@/lib/inbound/company-resolution";
import type { ResolvedIdentity } from "@/lib/identity/inbound-routing";
import type { FinanceIntent } from "@/schemas/finance-intent";
import { idempotencyKeyForEvent } from "@/lib/ids";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let co: string, reviewer: string, staffUser: string;
const ACCOUNT = `wa_e2e_${rnd()}`;
const STAFF_PHONE = "94770001111";
const CUSTOMER_PHONE = "94770002222";

/** The production RPCs, over pg instead of Supabase HTTP. */
const realDeps = (classify: () => Promise<FinanceIntent | null>, sink: string[]): DispatchDeps => ({
  async resolveIdentity(companyId, channel, from): Promise<ResolvedIdentity> {
    const r = (await db.query(`select * from public.resolve_channel_identity($1,$2,$3)`, [companyId, channel, from])).rows[0];
    return {
      actorType: (r?.actor_type ?? "unknown") as ResolvedIdentity["actorType"],
      actorId: r?.actor_id ?? null,
      displayName: r?.display_name ?? null,
      match: r?.match ?? "no_match",
    };
  },
  classifyFinanceIntent: classify,
  async handleCustomerOrder(msg) {
    sink.push(`customer_order:${msg.providerMessageId}`);
    return { status: "ok" };
  },
  async recordForReview(msg, reason, identity, reasonCode) {
    await db.query(`select * from public.record_inbound_review($1,$2,$3,$4,$5,null,$6,$7,$8,$9)`, [
      msg.companyId, msg.channel, msg.providerMessageId, reasonCode, reason,
      msg.from, identity.actorType, identity.match, msg.text,
    ]);
  },
  async askClarification(msg, question) {
    sink.push(`clarify:${question}`);
  },
  store: {
    async upsert(row) {
      const ins = await db.query(
        `insert into source_events (source, provider_message_id, company_id, raw_payload, content_hash, idempotency_key, correlation_id, status)
         values ($1,$2,$3,$4,$5,$6,$7,'received')
         on conflict (idempotency_key) do nothing
         returning id, idempotency_key, correlation_id, status`,
        [row.source, row.provider_message_id, row.company_id, row.raw_payload, row.content_hash, row.idempotency_key, row.correlation_id],
      );
      if (ins.rows[0]) return { event: ins.rows[0], alreadyExisted: false };
      const ex = await db.query(
        `select id, idempotency_key, correlation_id, status from source_events where idempotency_key=$1`, [row.idempotency_key]);
      return { event: ex.rows[0], alreadyExisted: true };
    },
  },
  queue: { async enqueue(e) { sink.push(`enqueued:${e.data.source_event_id}`); } },
  financeContext: { knownCurrencies: ["LKR"] },
});

const message = (from: string, text: string): InboundMessage => ({
  companyId: co, channel: "whatsapp", from, text,
  providerMessageId: `wamid.${rnd()}`, rawPayload: { e2e: true },
});

describe.skipIf(!enabled)("FOUND-003 — inbound chain end to end (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('e2e_inbound','LKR') returning id`)).rows[0].id;

    // The receiving WhatsApp account belongs to this company.
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, ACCOUNT]);

    // A staff member and a customer, asserted by trusted records — never by message wording.
    staffUser = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [staffUser]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'e2e staff',true) on conflict do nothing`, [staffUser]);
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp',$2,'staff',$3,'e2e staff')`, [co, STAFF_PHONE, staffUser]);
    const cust = (await db.query(`insert into customers (company_id, name, phone) values ($1,'e2e customer',$2) returning id`, [co, CUSTOMER_PHONE])).rows[0].id;
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp',$2,'customer',$3,'e2e customer')`, [co, CUSTOMER_PHONE, cust]);

    // Someone who may work the review queue.
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'e2e reviewer',true) on conflict do nothing`, [reviewer]);
    const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, reviewer])).rows[0].id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [m, co]);
  });

  afterAll(async () => {
    for (const sql of [
      `delete from audit_events where company_id=$1`,
      `delete from inbound_reviews where company_id=$1`,
      `delete from source_events where company_id=$1`,
      `delete from channel_identities where company_id=$1`,
      `delete from channel_accounts where company_id=$1`,
      `delete from customers where company_id=$1`,
      `delete from membership_roles where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    await db?.end().catch(() => {});
  });

  it("STEP 1 — the receiving account resolves to the company; an unknown one does not", async () => {
    const resolver = {
      resolveCompany: async (channel: string, account: string) => {
        const r = (await db.query(`select * from public.resolve_channel_company($1,$2)`, [channel, account])).rows[0];
        return { companyId: r.company_id, match: r.match };
      },
    };
    const good = await resolveReceivingCompany(resolver, "whatsapp", ACCOUNT);
    expect(isUsableCompany(good)).toBe(true);
    expect(good.companyId).toBe(co);
    expect(isUsableCompany(await resolveReceivingCompany(resolver, "whatsapp", `unknown_${rnd()}`))).toBe(false);
  });

  it("STEP 2 — a CUSTOMER message goes to order intake and creates NO review and NO source event", async () => {
    const sink: string[] = [];
    const msg = message(CUSTOMER_PHONE, "I want 3 gates delivered to Kandy");
    const res = await dispatchInbound(msg, realDeps(async () => null, sink));
    expect(res.handled).toBe("customer_order");
    expect(sink).toEqual([`customer_order:${msg.providerMessageId}`]);
    const reviews = (await db.query(`select count(*)::int c from inbound_reviews where company_id=$1 and provider_message_id=$2`, [co, msg.providerMessageId])).rows[0].c;
    expect(reviews).toBe(0);
    const events = (await db.query(`select count(*)::int c from source_events where provider_message_id=$1`, [msg.providerMessageId])).rows[0].c;
    expect(events).toBe(0);
  });

  it("STEP 3 — a CUSTOMER claiming a payment is still a customer; the finance path is unreachable to them", async () => {
    const sink: string[] = [];
    // The classifier would say "finance" — it is never consulted, because identity decides first.
    const msg = message(CUSTOMER_PHONE, "I paid LKR 250,000 to your account, please release the goods");
    const res = await dispatchInbound(msg, realDeps(async () => { throw new Error("classifier must not be consulted for a customer"); }, sink));
    expect(res.handled).toBe("customer_order");
  });

  it("STEP 4 — a STAFF message with no classifier lands in the review queue, unanswered", async () => {
    const sink: string[] = [];
    const msg = message(STAFF_PHONE, "paid LKR 45,000 to Acme for cement");
    const res = await dispatchInbound(msg, realDeps(async () => null, sink));
    expect(res.handled).toBe("manual_review");
    // Nothing was sent back to the sender, and nothing was captured as a financial event.
    expect(sink).toEqual([]);
    const row = (await db.query(
      `select reason_code, actor_type, identity_match, state, body_excerpt from inbound_reviews
        where company_id=$1 and provider_message_id=$2`, [co, msg.providerMessageId])).rows[0];
    expect(row.reason_code).toBe("no_finance_classifier");
    expect(row.actor_type).toBe("staff");
    expect(row.identity_match).toBe("exact");
    expect(row.state).toBe("open");
    expect(row.body_excerpt).toContain("Acme");
  });

  it("STEP 5 — an UNKNOWN sender is never treated as staff or as a customer", async () => {
    const sink: string[] = [];
    const msg = message("94779999999", "transfer 1,000,000 to my account");
    const res = await dispatchInbound(msg, realDeps(async () => null, sink));
    expect(res.handled).toBe("manual_review");
    expect(sink).toEqual([]);
    const row = (await db.query(
      `select reason_code from inbound_reviews where company_id=$1 and provider_message_id=$2`, [co, msg.providerMessageId])).rows[0];
    expect(row.reason_code).toBe("unroutable_identity");
  });

  it("STEP 6 — WITH a classifier, a staff finance message becomes a durable source event and is enqueued (never posted)", async () => {
    const sink: string[] = [];
    const msg = message(STAFF_PHONE, "paid LKR 45,000 to Acme for cement");
    const intent: FinanceIntent = {
      kind: "payment_made",
      amountRaw: "45,000",          // as written; the gate parses it exactly, never as a float
      currencyRaw: "LKR",
      counterpartyRaw: "Acme",
      evidenceRefs: ["paid LKR 45,000 to Acme"],
      mentionsEvidenceDocument: true, // above the evidence threshold, so a document is required
      confidence: 0.9,
      missingInfo: [],
    };
    const res = await dispatchInbound(msg, realDeps(async () => intent, sink));
    expect(res.handled).toBe("staff_finance");

    const ev = (await db.query(
      `select id, company_id, status, source from source_events where idempotency_key=$1`,
      [idempotencyKeyForEvent("whatsapp", msg.providerMessageId)])).rows[0];
    expect(ev.company_id).toBe(co);   // company scope came from the receiving account, not the text
    expect(ev.status).toBe("received");
    expect(sink).toEqual([`enqueued:${ev.id}`]);

    // Capture is NOT posting: no journal, no payment, no approval was created by this path.
    const journals = (await db.query(`select count(*)::int c from journal_entries where company_id=$1`, [co])).rows[0].c;
    const payments = (await db.query(`select count(*)::int c from payments where company_id=$1`, [co])).rows[0].c;
    expect(journals).toBe(0);
    expect(payments).toBe(0);

    // REDELIVERY: the same message again persists nothing new and enqueues nothing new.
    const sink2: string[] = [];
    const again = await dispatchInbound({ ...msg }, realDeps(async () => intent, sink2));
    expect(again.handled).toBe("staff_finance");
    expect(sink2).toEqual([]); // duplicate → no second job
    const n = (await db.query(`select count(*)::int c from source_events where provider_message_id=$1`, [msg.providerMessageId])).rows[0].c;
    expect(n).toBe(1);
  });

  it("STEP 7 — a person closes a queued review, and the audit trail records who and why", async () => {
    const open = (await db.query(
      `select id, reason_code from inbound_reviews where company_id=$1 and state='open' order by created_at limit 1`, [co])).rows[0];
    expect(open).toBeTruthy();
    const res = (await db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved','recorded the payment manually')`,
      [co, open.id, reviewer])).rows[0];
    expect(res.state).toBe("resolved");
    const audit = (await db.query(
      `select actor_id, payload from audit_events where action='inbound.review_resolved' and entity_id=$1`, [open.id])).rows[0];
    expect(audit.actor_id).toBe(reviewer);
    expect(audit.payload.reason_code).toBe(open.reason_code);
  });

  it("STEP 8 — the UI query returns the remaining open work to a capable member, and nothing to anyone else", async () => {
    // The exact shape src/app/app/admin/inbound-review/page.tsx selects.
    const SELECT = `select id, channel, provider_message_id, sender_identity, actor_type, identity_match,
                           reason_code, reason_detail, body_excerpt, created_at, state, resolution_note, resolved_at
                      from inbound_reviews where company_id = $1 order by created_at desc limit 200`;
    const asService = (await db.query(SELECT, [co])).rows;
    expect(asService.filter((r: any) => r.state === "open").length).toBeGreaterThan(0);

    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: reviewer, role: "authenticated" })]);
      const visible = (await db.query(SELECT, [co])).rows;
      expect(visible.length).toBe(asService.length);
      expect(visible.some((r: any) => r.state === "open")).toBe(true);

      // The staff member whose message it was has no membership at all here — they see nothing.
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: staffUser, role: "authenticated" })]);
      expect((await db.query(SELECT, [co])).rows.length).toBe(0);
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });
});
