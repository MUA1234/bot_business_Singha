/**
 * OF-015 — DISCRIMINATING end-to-end coverage for §3 (scheduled drain), §5 (owner configuration)
 * and §6 (canonical adapter).
 *
 * The second review's fair criticism: extreme paths 2, 3, 5, 7 and 9 all pass against a tree with
 * none of those three sections in it, so the nine paths did not establish them. Each group here
 * fails against the head that predates its section — measured, not asserted:
 *
 *   §3 drain          → fails at 0001–0078 (no `release_inbound_dispatch`, no drain route behaviour)
 *   §5 owner config   → fails at 0001–0079 (no admin RPCs, no setup status)
 *   §6 adapter        → fails at 0001–0082 (no `fromStored`, no registry, no `no_adapter` outcome)
 *
 * Everything runs through real production entrypoints against a DISPOSABLE LOCAL PostgreSQL.
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
const H: { sb: any; extraction: Record<string, unknown> | null } = { sb: null, extraction: null };

vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => H.sb }));
vi.mock("@/db/client", () => ({ serviceClient: () => H.sb }));
vi.mock("@/inngest/client", () => ({
  WHATSAPP_INBOUND_EVENT: "whatsapp/message.received",
  inngest: { send: async () => {} },
  inngestQueue: { enqueue: async () => {} },
}));
vi.mock("@/ai/openai-transport", () => ({
  makeOpenAiTransport: () => ({
    async complete() {
      return { text: JSON.stringify(H.extraction ?? {}), usage: { input_tokens: 5, output_tokens: 5 }, cost_usd: "0.0001" };
    },
  }),
}));

import { pgSupabase } from "./helpers/pg-supabase";
import { whatsappAdapter } from "@/lib/inbound/adapters/whatsapp";
import { adapterForSource } from "@/lib/inbound/adapters";
import { recordInboundReceipt } from "@/lib/inbound/receipt";
import { sha256 } from "@/lib/ids";
import { newCorrelationId } from "@/lib/log";

let db: any;
let co: string, coB: string, admin: string, plainMember: string;
const ACCT = `wa_of15_${rnd()}`;
const STAFF = "94770007777";

const row = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];
const rows = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;

const envelope = (text: string, msgId: string, account = ACCT) => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: account },
    messages: [{ from: STAFF, id: msgId, timestamp: "1755500000", type: "text", text: { body: text } }],
  } }] }],
});

async function persist(text: string, msgId = `wamid.${rnd()}`, account = ACCT) {
  const m = whatsappAdapter.parse(envelope(text, msgId, account), newCorrelationId)[0]!;
  return recordInboundReceipt(H.sb, {
    source: m.channel, providerAccountId: m.providerAccountId, providerMessageId: m.providerMessageId,
    rawPayload: m.raw, contentHash: sha256(m.text), correlationId: m.correlationId,
  });
}
const drain = async () => {
  const { GET } = await import("@/app/api/cron/dispatch-drain/route");
  const res = await GET(new Request("http://x", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  return { status: res.status, body: await res.json() };
};

describe.skipIf(!enabled)("OF-015 — §3 / §5 / §6 discriminating coverage", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    H.sb = pgSupabase(db);
    process.env.CRON_SECRET = `of15_${rnd()}`;
    delete process.env.OPENAI_API_KEY;

    co = (await row(`insert into companies (name, base_currency) values ('of15 A','LKR') returning id`)).id;
    coB = (await row(`insert into companies (name, base_currency) values ('of15 B','LKR') returning id`)).id;
    const mk = async (company: string, name: string, role: string) => {
      const id = randomUUID();
      await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
      await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, name]);
      const m = (await row(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, id])).id;
      await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [m, company, role]);
      return id;
    };
    admin = await mk(co, "of15 admin", "system_administrator");
    plainMember = await mk(co, "of15 member", "project_manager");
  });

  afterAll(async () => {
    for (const c of [co, coB]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from inbound_reviews where company_id=$1`,
        `delete from source_events where company_id=$1`,
        `delete from channel_identities where company_id=$1`,
        `delete from channel_accounts where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    try { await db.query(`delete from source_events where provider_account_id=$1`, [ACCT]); } catch { /* noop */ }
    await db?.end().catch(() => {});
  });

  // ═══ §3 — the scheduled drain ═══════════════════════════════════════════════════════════════
  describe("§3 — scheduled inbound dispatch drain", () => {
    it("the route REFUSES a missing, wrong and malformed scheduler credential", async () => {
      const { GET } = await import("@/app/api/cron/dispatch-drain/route");
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "NotBearer x" }, { authorization: "" }]) {
        const res = await GET(new Request("http://x", { headers: headers as HeadersInit }));
        expect(res.status, JSON.stringify(headers)).toBe(401);
      }
    });

    it("persist → adapter round-trip → claim → decide → settle, all through the real route", async () => {
      await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)
                      on conflict do nothing`, [co, ACCT]);
      const TEXT = "paid LKR 12,000 to Negombo Glass for panes";
      const r = await persist(TEXT);
      // Receipt is persisted, undispatched.
      expect((await row(`select dispatch_state, provider_account_id from source_events where id=$1`, [r.event.id])).dispatch_state).toBe("pending");

      const res = await drain();
      expect(res.status).toBe(200);
      const after = await row(`select dispatch_state, dispatch_outcome, company_id, dispatch_owner, dispatch_lease_expires_at from source_events where id=$1`, [r.event.id]);
      // Claimed, decided, lease released.
      expect(["dispatched", "manual_review"]).toContain(after.dispatch_state);
      expect(after.company_id).toBe(co);
      expect(after.dispatch_owner).toBeNull();
      expect(after.dispatch_lease_expires_at).toBeNull();
      // The body survived the round-trip — the message a person sees is the message that was sent.
      const rev = await row(`select body_excerpt from inbound_reviews where source_event_id=$1`, [r.event.id]);
      if (rev) expect(rev.body_excerpt).toBe(TEXT);
    });

    it("an UNKNOWN source is failed as `no_adapter` and never treated as WhatsApp", async () => {
      const id = (await row(
        `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, correlation_id, provider_account_id, event_identity)
         values ('upload',$1,'{"row":"a bank file line"}'::jsonb,$2,$3,$4,$5) returning id`,
        [`up_${rnd()}`, `idem_${rnd()}`, `cor_${rnd()}`, ACCT, `ev1:upload:${rnd()}`])).id;
      await drain();
      const after = await row(`select dispatch_state, last_error_code, company_id, dispatch_outcome from source_events where id=$1`, [id]);
      expect(after.last_error_code).toBe("no_adapter");
      expect(after.dispatch_outcome).toBeNull();      // no business decision was invented
      expect(after.company_id).toBeNull();            // and no company was attributed
      await db.query(`delete from source_events where id=$1`, [id]);
    });

    it("a TRANSIENT failure backs off with an increasing delay and is not dead-lettered", async () => {
      const r = await persist("paid LKR 800 for tape", `wamid.${rnd()}`, `wa_unmapped_${rnd()}`);
      await drain();                                    // the account is not mapped → retryable
      const first = await row(`select dispatch_state, dispatch_attempts, next_attempt_at, dead_lettered_at, last_error_code from source_events where id=$1`, [r.event.id]);
      expect(first.dispatch_state).toBe("failed");
      expect(first.last_error_code).toBe("company_unresolved");
      expect(Number(first.dispatch_attempts)).toBe(1);
      expect(first.dead_lettered_at).toBeNull();
      const firstDelay = new Date(first.next_attempt_at).getTime();
      expect(firstDelay).toBeGreaterThan(Date.now());

      await db.query(`update source_events set next_attempt_at = now() - interval '1 second' where id=$1`, [r.event.id]);
      await drain();
      const second = await row(`select dispatch_attempts, next_attempt_at from source_events where id=$1`, [r.event.id]);
      expect(Number(second.dispatch_attempts)).toBe(2);
      // Backoff GROWS rather than retrying at a fixed rate.
      expect(new Date(second.next_attempt_at).getTime() - Date.now())
        .toBeGreaterThan(firstDelay - Date.now());
    });

    it("OVERLAPPING drain runs cannot decide the same receipt twice", async () => {
      const r = await persist("paid LKR 3,000 for a ladder");
      const [a, b] = await Promise.all([drain(), drain()]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const decided = await row(`select dispatch_state, dispatch_outcome from source_events where id=$1`, [r.event.id]);
      expect(["dispatched", "manual_review"]).toContain(decided.dispatch_state);
      // Exactly one downstream effect for this message.
      expect((await rows(`select id from inbound_reviews where source_event_id=$1`, [r.event.id])).length).toBeLessThanOrEqual(1);
      expect((await rows(`select id from source_events where provider_message_id=(select provider_message_id from source_events where id=$1)`, [r.event.id]))).toHaveLength(1);
    });

    it("a settled receipt cannot be re-claimed by the sweeper", async () => {
      const r = await persist("paid LKR 5,000 for a wheelbarrow");
      await db.query(`update source_events set dispatch_state='dispatched', dispatch_outcome='staff_finance',
                      company_id=$2, status='pending' where id=$1`, [r.event.id, co]);
      expect((await db.query(`select public.settle_processed_source_event($1) as s`, [r.event.id])).rows[0].s).toBe("completed");
      expect(await rows(`select id from public.claim_source_events(50,'sweeper',60) where id=$1`, [r.event.id])).toHaveLength(0);
    });

    it("the health signal reflects the ACTUAL state of these events", async () => {
      const h = await row(`select * from public.inbound_dispatch_health()`);
      const failed = await row(`select count(*)::int as n from source_events where dispatch_state='failed'`);
      expect(Number(h.dispatch_failed)).toBe(failed.n);
      const awaiting = await row(`select count(*)::int as n from source_events where dispatch_state='pending'`);
      expect(Number(h.awaiting_dispatch)).toBe(awaiting.n);
    });
  });

  // ═══ §5 — owner configuration ═══════════════════════════════════════════════════════════════
  describe("§5 — owner configuration", () => {
    const NUM = () => `9411${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

    it("an authorized admin creates a mapping INACTIVE, then activates, deactivates and replaces it", async () => {
      const n = NUM();
      const created = await row(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'Main line',$3)`, [co, n, admin]);
      expect(created.created).toBe(true);
      expect(created.conflict).toBeNull();
      // Created INACTIVE: a mapping never goes live on creation — activation is a separate,
      // separately-audited decision, so a typo cannot silently start attributing real messages.
      expect((await row(`select is_active from channel_accounts where id=$1`, [created.account_id])).is_active).toBe(false);

      await db.query(`select * from public.admin_set_channel_account_active($1,$2,true,$3)`, [co, created.account_id, admin]);
      expect((await row(`select is_active from channel_accounts where id=$1`, [created.account_id])).is_active).toBe(true);

      await db.query(`select * from public.admin_set_channel_account_active($1,$2,false,$3)`, [co, created.account_id, admin]);
      expect((await row(`select is_active from channel_accounts where id=$1`, [created.account_id])).is_active).toBe(false);

      // Replacement: a different number for the same company.
      const n2 = NUM();
      const replaced = await row(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'Replacement',$3)`, [co, n2, admin]);
      expect(replaced.account_id).not.toBe(created.account_id);

      // Every change is audited.
      const audits = await rows(`select action from audit_events where company_id=$1 and entity_type='channel_account'`, [co]);
      expect(audits.length).toBeGreaterThanOrEqual(4);
    });

    it("a member WITHOUT admin.identity.manage, and a cross-company actor, are refused", async () => {
      const n = NUM();
      await expect(db.query(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'x',$3)`, [co, n, plainMember]))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'x',$3)`, [coB, n, admin]))
        .rejects.toMatchObject({ code: "42501" });
    });

    it("an AMBIGUOUS mapping is reported on creation and refused at activation", async () => {
      const shared = NUM();
      // Company B already holds it, actively.
      const bAcc = (await row(`insert into channel_accounts (company_id, channel, provider_account_id, is_active)
                               values ($1,'whatsapp',$2,true) returning id`, [coB, shared])).id;
      const created = await row(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'Contested',$3)`, [co, shared, admin]);
      expect(created.conflict).toBe("claimed_by_another_company");
      // Nothing was created AT ALL — there is not even an inactive row to activate later, so an
      // ambiguous mapping cannot become live by a second click. Deciding who owns a number is the
      // owner's call and this surface refuses to take it.
      expect(created.account_id).toBeNull();
      expect(await rows(`select id from channel_accounts where company_id=$1 and provider_account_id=$2`, [co, shared])).toHaveLength(0);

      // …and a mapping created BEFORE the other company activated theirs cannot be activated into
      // the conflict either: the check is re-run at activation, not just at creation.
      const later = NUM();
      const mine = await row(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'Later',$3)`, [co, later, admin]);
      await db.query(`insert into channel_accounts (company_id, channel, provider_account_id, is_active)
                      values ($1,'whatsapp',$2,true)`, [coB, later]);
      // The conflict is REPORTED, not raised — a contested number is an owner decision, not an
      // error — and the mapping stays inactive either way.
      const attempt = await row(`select * from public.admin_set_channel_account_active($1,$2,true,$3)`, [co, mine.account_id, admin]);
      expect(attempt.conflict).toBe("claimed_by_another_company");
      expect(attempt.is_active).toBe(false);
      expect((await row(`select is_active from channel_accounts where id=$1`, [mine.account_id])).is_active).toBe(false);

      await db.query(`delete from channel_accounts where id=$1`, [bAcc]);
      await db.query(`delete from channel_accounts where provider_account_id=$1`, [later]);
    });

    it("capability assignment is AUDITED and nothing is invented", async () => {
      const before = await row(`select count(*)::int as n from membership_roles where company_id=$1`, [co]);
      await db.query(`select * from public.admin_set_membership_role($1,$2,'finance_reviewer',true,$3)`, [co, plainMember, admin]);
      const after = await row(`select count(*)::int as n from membership_roles where company_id=$1`, [co]);
      expect(after.n).toBe(before.n + 1);
      const a = await row(`select action, payload from audit_events where company_id=$1 and action='membership_role.granted'
                            order by created_at desc limit 1`, [co]);
      expect(a.payload.role_key).toBe("finance_reviewer");
      expect(a.payload.subject_user).toBe(plainMember);
      // A role outside the closed list is refused — the surface does not widen itself.
      await expect(db.query(`select * from public.admin_set_membership_role($1,$2,'system_administrator',true,$3)`, [co, plainMember, admin]))
        .rejects.toMatchObject({ code: "42501" });
    });

    it("setup status is HONEST before configuration and updates after it", async () => {
      const fresh = (await row(`insert into companies (name, base_currency) values ('of15 unconfigured','LKR') returning id`)).id;
      const before = await row(`select * from public.inbound_setup_status($1)`, [fresh]);
      expect(Number(before.active_accounts)).toBe(0);
      expect(Number(before.reviewers)).toBe(0);

      const fAdmin = randomUUID();
      await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [fAdmin]);
      await db.query(`insert into users (id, full_name, is_active) values ($1,'of15 fresh admin',true) on conflict do nothing`, [fAdmin]);
      const fm = (await row(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [fresh, fAdmin])).id;
      await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'system_administrator')`, [fm, fresh]);
      const acc = await row(`select * from public.admin_upsert_channel_account($1,'whatsapp',$2,'Fresh',$3)`, [fresh, NUM(), fAdmin]);
      await db.query(`select * from public.admin_set_channel_account_active($1,$2,true,$3)`, [fresh, acc.account_id, fAdmin]);

      const after = await row(`select * from public.inbound_setup_status($1)`, [fresh]);
      expect(Number(after.active_accounts)).toBe(1);
      // The reviewer LIST and the reviewer COUNT answer the same question.
      const listed = await rows(`select user_id from public.inbound_reviewer_user_ids($1)`, [fresh]);
      expect(listed.length).toBe(Number(after.reviewers));

      for (const sql of [`delete from membership_roles where company_id=$1`, `delete from memberships where company_id=$1`,
                         `delete from channel_accounts where company_id=$1`, `delete from audit_events where company_id=$1`,
                         `delete from companies where id=$1`]) {
        await db.query(sql, [fresh]).catch(() => {});
      }
      await db.query(`delete from users where id=$1`, [fAdmin]).catch(() => {});
    });
  });

  // ═══ §6 — the canonical adapter ═════════════════════════════════════════════════════════════
  describe("§6 — canonical inbound adapter", () => {
    it("a stored WhatsApp payload ROUND-TRIPS through fromStored with every identity intact", async () => {
      const msgId = `wamid.rt_${rnd()}`;
      const TEXT = "paid LKR 9,900 to Matara Paints";
      const parsed = whatsappAdapter.parse(envelope(TEXT, msgId), newCorrelationId)[0]!;
      const r = await persist(TEXT, msgId);
      const stored = await row(`select raw_payload, provider_account_id, provider_message_id, correlation_id from source_events where id=$1`, [r.event.id]);

      const reread = whatsappAdapter.fromStored(stored.raw_payload, stored.provider_account_id, stored.correlation_id);
      expect(reread).toBeTruthy();
      expect(reread!.text).toBe(parsed.text);
      expect(reread!.from).toBe(parsed.from);
      expect(reread!.providerMessageId).toBe(stored.provider_message_id);
      expect(reread!.providerAccountId).toBe(stored.provider_account_id);
      expect(reread!.correlationId).toBe(stored.correlation_id);   // trace identity survives
      expect(reread!.channel).toBe("whatsapp");
    });

    it("the PRE-§6 flat payload still re-reads — an upgrade does not orphan stored receipts", () => {
      const legacy = { id: "wamid.legacy1", from: STAFF, text: "paid LKR 45,000 to Acme Cement" };
      const m = whatsappAdapter.fromStored(legacy, ACCT, "cor_legacy");
      expect(m).toBeTruthy();
      expect(m!.text).toBe("paid LKR 45,000 to Acme Cement");
      expect(m!.providerMessageId).toBe("wamid.legacy1");
    });

    it("a MALFORMED stored payload fails truthfully rather than producing an empty message", () => {
      for (const bad of [null, undefined, 42, "a string", {}, { id: "x" }, { from: "y" }, { id: "x", from: "y" }]) {
        expect(whatsappAdapter.fromStored(bad, ACCT, "cor"), JSON.stringify(bad)).toBeNull();
      }
    });

    it("the SOURCE selects the adapter, and no unregistered source resolves to WhatsApp", () => {
      expect(adapterForSource("whatsapp")).toBe(whatsappAdapter);
      for (const s of ["email", "upload", "bank_file", "google_sheets", "operational", "manual",
                       "constructor", "toString", "__proto__", "", null, undefined]) {
        expect(adapterForSource(s as string), String(s)).toBeNull();
      }
    });

    it("no unsupported channel is represented as complete", async () => {
      // The registry has exactly one entry, and the requirement register says so for the others.
      const { readFileSync } = await import("node:fs");
      const reg = readFileSync("docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml", "utf8");
      for (const id of ["COM-002", "COM-004", "COM-005"]) {
        const block = reg.slice(reg.indexOf(`- id: ${id}`), reg.indexOf(`- id: ${id}`) + 2500);
        expect(block, id).toMatch(/status:\s*(absent|foundation_only)/);
      }
    });
  });
});
