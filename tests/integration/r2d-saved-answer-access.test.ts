/**
 * R2D — a saved answer must not outlive the access it was built on.
 *
 * Storing citations as references protects the RECORDS. It does nothing for the prose: an answer
 * that says "invoice INV-2026-0043 is LKR 1,250,000.50 overdue" has already copied the facts out
 * of the record, and those sentences re-check nothing when someone reads them back months later.
 *
 * So every case here plants a distinctive marker inside the inaccessible record, lets the answer
 * quote it, then removes the reader's access and asserts the marker never reappears — in the
 * response or in anything rendered from it.
 *
 * Synthetic data, disposable local PostgreSQL, no network, no live model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgSupabase } from "./helpers/pg-supabase";
import {
  readThreadForViewer, resolveThreadAccess, restrictedMessage, REVIEW_CAPABILITY,
} from "@/kernel/ask-ai/review";
import { asMembershipId, asCompanyId } from "@/kernel/ask-ai/identity";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

/** Distinctive enough that its presence anywhere is unambiguous. */
const MARKER = "ZZ-SECRET-MARKER-7F3A9C";

const CO_A = randomUUID();
const CO_B = randomUUID();
const AUTHOR = randomUUID();
const REVIEWER = randomUUID();

let raw: pg.Client;
let authorMembership = "";
let reviewerMembership = "";
let secretTaskId = "";
let db: ReturnType<typeof pgSupabase>;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** A saved thread whose ASSISTANT turn quotes the marker and cites the secret record. */
async function seedThreadQuotingSecret(): Promise<string> {
  const { rows: th } = await q(
    `insert into ask_ai_threads (company_id, membership_id, language)
     values ($1,$2,'en') returning id`, [CO_A, authorMembership]);
  const threadId = th[0].id as string;

  await q(`insert into ask_ai_turns (thread_id, company_id, role, content, language)
           values ($1,$2,'user','why is this overdue','en')`, [threadId, CO_A]);
  const { rows: t } = await q(
    `insert into ask_ai_turns (thread_id, company_id, role, content, language, confidence)
     values ($1,$2,'assistant',$3,'en',0.9) returning id`,
    [threadId, CO_A, `The blocked item is ${MARKER} and it is overdue by 40 days.`]);
  await q(`insert into ask_ai_citations (turn_id, company_id, source_table, source_id)
           values ($1,$2,'tasks',$3)`, [t[0].id, CO_A, secretTaskId]);
  return threadId;
}

/** Access predicate for a reader who may see everything except the secret task. */
const cannotSeeSecret = async (table: string, id: string) =>
  !(table === "tasks" && id === secretTaskId);

const canSeeEverything = async () => true;

describe.skipIf(!enabled)("R2D — a saved answer re-authorises on read", () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    db = pgSupabase(raw);

    for (const co of [CO_A, CO_B]) {
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
        [co, `saved ${co.slice(0, 8)}`]);
    }
    for (const [u, name, co] of [
      [AUTHOR, "Author", CO_A], [REVIEWER, "Reviewer", CO_A],
    ] as const) {
      await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
      await q(`insert into users (id, full_name, is_active) values ($1,$2,true)
               on conflict (id) do nothing`, [u, name]);
    }
    const { rows: am } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
      [CO_A, AUTHOR]);
    authorMembership = am[0].id as string;
    const { rows: rm } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
      [CO_A, REVIEWER]);
    reviewerMembership = rm[0].id as string;

    const { rows: task } = await q(
      `insert into tasks (company_id, title, status, due_date)
       values ($1,$2,'blocked','2026-01-01') returning id`, [CO_A, `${MARKER} restricted work`]);
    secretTaskId = task[0].id as string;
  }, 180_000);

  afterAll(async () => { await raw?.end(); });

  const reviewer = (threadId: string) => ({
    threadId, companyId: asCompanyId(CO_A), viewerMembershipId: asMembershipId(reviewerMembership),
    capabilities: new Set([REVIEW_CAPABILITY]),
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  it("a reviewer WITH access to every citation sees the answer", async () => {
    const threadId = await seedThreadQuotingSecret();
    const out = await readThreadForViewer(db, reviewer(threadId), canSeeEverything);
    expect(out.state).toBe("visible");
    if (out.state === "visible") {
      expect(out.turns.some((t) => t.content.includes(MARKER))).toBe(true);
    }
  }, 180_000);

  it("a reviewer who cannot open ONE cited record never sees the marker", async () => {
    // The capability grants review; it does not grant the underlying records.
    const threadId = await seedThreadQuotingSecret();
    const out = await readThreadForViewer(db, reviewer(threadId), cannotSeeSecret);

    expect(out.state).toBe("restricted");
    const serialised = JSON.stringify(out);
    expect(serialised, "the marker leaked through the restricted response").not.toContain(MARKER);
    expect(serialised).not.toMatch(/overdue by 40 days/);
  }, 180_000);

  it("the restricted state discloses nothing about the records", async () => {
    const threadId = await seedThreadQuotingSecret();
    const out = await readThreadForViewer(db, reviewer(threadId), cannotSeeSecret);
    const text = JSON.stringify(out) + restrictedMessage();

    // No title, no id, no count, no table name — each of which would confirm existence.
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(secretTaskId);
    expect(text).not.toMatch(/\b\d+ record/);
    expect(restrictedMessage()).not.toMatch(/task|invoice|customer/i);
  }, 180_000);

  it("losing the review capability denies the thread immediately", async () => {
    const threadId = await seedThreadQuotingSecret();
    const out = await readThreadForViewer(
      db,
      { ...reviewer(threadId), capabilities: new Set<string>() },
      canSeeEverything,
    );
    expect(out.state).toBe("denied");
    expect(JSON.stringify(out)).not.toContain(MARKER);
  }, 180_000);

  it("a DELETED cited record withholds the answer rather than showing stale facts", async () => {
    const threadId = await seedThreadQuotingSecret();
    // The citation now points at nothing. The prose still repeats what the record said.
    const gone = async (table: string, id: string) => !(table === "tasks" && id === secretTaskId);
    const out = await readThreadForViewer(db, reviewer(threadId), gone);
    expect(out.state).toBe("restricted");
    expect(JSON.stringify(out)).not.toContain(MARKER);
  }, 180_000);

  it("a thread in ANOTHER COMPANY is denied, and indistinguishable from absent", async () => {
    const { rows: th } = await q(
      `insert into ask_ai_threads (company_id, membership_id, language)
       values ($1,$2,'en') returning id`, [CO_B, authorMembership]);

    const foreign = await readThreadForViewer(
      db,
      { threadId: th[0].id as string, companyId: asCompanyId(CO_A),
        viewerMembershipId: asMembershipId(reviewerMembership), capabilities: new Set([REVIEW_CAPABILITY]) },
      canSeeEverything,
    );
    const absent = await readThreadForViewer(
      db,
      { threadId: randomUUID(), companyId: asCompanyId(CO_A),
        viewerMembershipId: asMembershipId(reviewerMembership), capabilities: new Set([REVIEW_CAPABILITY]) },
      canSeeEverything,
    );
    // Identical outcomes: a different answer would confirm the foreign thread exists.
    expect(foreign).toEqual(absent);
    expect(foreign.state).toBe("denied");
  }, 180_000);

  it("an EXPIRED thread is restricted, not shown", async () => {
    const threadId = await seedThreadQuotingSecret();
    await q(`update ask_ai_threads set expires_at = now() - interval '1 day' where id=$1`,
      [threadId]);

    const out = await readThreadForViewer(db, reviewer(threadId), canSeeEverything);
    expect(out.state).toBe("restricted");
    if (out.state === "restricted") expect(out.reason).toBe("thread_expired");
    expect(JSON.stringify(out)).not.toContain(MARKER);
  }, 180_000);

  it("the AUTHOR is also re-authorised — losing access closes their own saved answer", async () => {
    // The person who asked is not exempt: if their access was revoked, the answer they received
    // is still the record's content.
    const threadId = await seedThreadQuotingSecret();
    const out = await readThreadForViewer(
      db,
      { threadId, companyId: asCompanyId(CO_A), viewerMembershipId: asMembershipId(authorMembership),
        capabilities: new Set<string>() },
      cannotSeeSecret,
    );
    expect(out.state).toBe("restricted");
    expect(JSON.stringify(out)).not.toContain(MARKER);
  }, 180_000);

  it("ownership and capability are resolved separately from the records", async () => {
    const threadId = await seedThreadQuotingSecret();
    const asOwner = await resolveThreadAccess(db, {
      threadId, companyId: asCompanyId(CO_A), viewerMembershipId: asMembershipId(authorMembership),
      capabilities: new Set<string>(),
    });
    expect(asOwner.access).toBe("owner");

    const asStranger = await resolveThreadAccess(db, {
      threadId, companyId: asCompanyId(CO_A), viewerMembershipId: asMembershipId(reviewerMembership),
      capabilities: new Set<string>(),
    });
    // A manager's job title is never consulted — only the capability.
    expect(asStranger.access).toBe("denied");
  }, 180_000);
});
