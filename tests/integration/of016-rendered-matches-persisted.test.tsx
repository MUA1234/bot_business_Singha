/**
 * OF-016 (the rendered half) — what a reviewer SEES is what the database HOLDS.
 *
 * The browser check (scripts/verify/browser-check-duplicate-reviews.mjs) proves the route exists,
 * is gated, and lays out at 390/768/1440 — but it cannot sign in, because there is no Supabase
 * instance in this container. So it cannot show the queue WITH ROWS IN IT.
 *
 * This closes that gap the only honest way available: seed a paused payment, resolve it through
 * the REAL `resolve_duplicate_review` RPC as a REAL authenticated human, read it back through the
 * REAL `duplicate_review_queue` function, hand that row to the REAL component, and assert the
 * rendered words against the stored values. A screen cannot then drift from the record it claims
 * to show. Neither check is sufficient alone.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { ReviewCardView, type ReviewItem } from "@/app/app/finance/duplicate-reviews/ReviewCard";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
const SUFFIX = rnd();
const AUTH = `of16r_${SUFFIX}`;
const conns: any[] = [];
let co: string, reviewer: string;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

async function mkConn(role?: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({
    connectionString: role ? URL.replace(/\/\/[^@]*@/, `//${role}:probe@`) : URL, ssl: mkSsl(URL),
  });
  await c.connect();
  conns.push(c);
  return c;
}

describe.skipIf(!enabled)("OF-016 — rendered output matches persisted state", () => {
  beforeAll(async () => {
    db = await mkConn();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query(`drop role if exists ${AUTH}`);
    await db.query(`create role ${AUTH} login password 'probe'`);
    await db.query(`grant authenticated to ${AUTH}`);
    co = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16r ${SUFFIX}`])).id;
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'Nimali Perera',true) on conflict do nothing`, [reviewer]);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, reviewer]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, co]);
  });

  afterAll(async () => {
    for (const c of conns.slice(1)) await c.end().catch(() => {});
    for (const sql of [
      `delete from duplicate_reviews where company_id=$1`,
      `delete from financial_events where company_id=$1`,
      `delete from source_events where company_id=$1`,
      `delete from membership_roles where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    try { await db.query(`drop role if exists ${AUTH}`); } catch { /* noop */ }
    await db.end().catch(() => {});
  });

  async function seedAndRead(): Promise<{ row: ReviewItem; review: string; candidate: string; earlier: string }> {
    const src = (await one(
      `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                  dispatch_state, dispatch_outcome, company_id, correlation_id, next_attempt_at)
       values ('whatsapp',$1,'{}'::jsonb,$2,'completed','dispatched','staff_finance',$3,$4, now()) returning id`,
      [`pm-${rnd()}`, `idem-${rnd()}`, co, `corr-${rnd()}`])).id;
    const earlier = (await one(
      `insert into financial_events (company_id, event_type, state, amount, currency, transaction_date,
                                     counterparty_name, purpose, correlation_id, risk_flags, missing_fields)
       values ($1,'expense','posted','128500.75','LKR','2026-08-09','Ceylon Hardware (Pvt) Ltd','roof sheets',$2,'{}','{}')
       returning id`, [co, `corr-${rnd()}`])).id;
    const candidate = (await one(
      `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                     transaction_date, counterparty_name, purpose, correlation_id, risk_flags, missing_fields)
       values ($1,$2,'expense','awaiting_information','128500.75','LKR','2026-08-09','Ceylon Hardware (Pvt) Ltd','roof sheets',$3,'{}','{}')
       returning id`, [co, src, `corr-${rnd()}`])).id;
    const review = (await one(
      `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score,
                                      feature_contributions, evidence_present, evidence_missing, algorithm_version)
       values ($1,$2,$3,0.9350,'{"amount":0.5,"date":0.3,"counterparty":0.135}'::jsonb,
               '{amount,date}','{counterparty}','dup/v2-evidence-required') returning id`,
      [co, candidate, earlier])).id;

    const c = await mkConn(AUTH);
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
    const row = (await c.query(`select * from public.duplicate_review_queue($1)`, [co])).rows
      .find((r: any) => r.review_id === review);
    await c.query("rollback");
    return { row: row as ReviewItem, review, candidate, earlier };
  }

  it("an OPEN review renders the amounts, dates, counterparties and evidence the database holds", async () => {
    const { row, candidate, earlier } = await seedAndRead();
    expect(row, "the RPC must return the row before it can be rendered").toBeTruthy();
    const html = renderToStaticMarkup(createElement(ReviewCardView, { item: row }));
    const t = text(html);

    // Money, rendered from the stored decimal — not re-derived, not rounded on the way out.
    expect(t).toContain("LKR 128,500.75");
    // The column is numeric(_,4), so the STORED value carries four decimals. The card renders it
    // at the currency's own scale (LKR → 2) without losing the stored precision — asserting both
    // is the point: the screen must be readable AND faithful.
    expect(row.candidate_amount).toBe("128500.7500");
    expect(row.matched_amount).toBe("128500.7500");

    // Both transactions are shown, with the stored date and counterparty.
    expect(t).toContain("2026-08-09");
    expect(t).toContain("Ceylon Hardware (Pvt) Ltd");
    expect(html).toContain(candidate);
    expect(html).toContain(earlier);

    // The score is the stored score, and the per-feature contributions are shown rather than hidden.
    expect(Number(row.score)).toBeCloseTo(0.935, 4);
    expect(t).toContain("94%");            // 0.935 → 94%
    expect(t).toMatch(/amount 50%/);
    expect(t).toMatch(/date 30%/);
    expect(t).toMatch(/counterparty 14%/); // 0.135 → 14%

    // Missing evidence is named AND explained — a reviewer must not read absence as agreement.
    expect(t).toContain("Evidence missing: counterparty");
    expect(t).toContain("missing evidence contributed nothing to the score");

    // The rule version travels with the decision.
    expect(t).toContain("dup/v2-evidence-required");

    // The single most important sentence on the screen.
    expect(t).toMatch(/suspected duplicate raised by a similarity score/i);
    expect(t).toMatch(/not proven fraud/i);
    expect(t).toMatch(/paused and reversible/i);
    expect(t).toContain("Awaiting a decision");
  });

  it("a RESOLVED review renders the real decision, the real human and the real reason", async () => {
    const { review } = await seedAndRead();
    const c = await mkConn(AUTH);
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
    await c.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','two separate deliveries, both invoiced')`, [review]);
    const row = (await c.query(`select * from public.duplicate_review_queue($1)`, [co])).rows
      .find((r: any) => r.review_id === review);
    await c.query("rollback");

    const t = text(renderToStaticMarkup(createElement(ReviewCardView, { item: row as ReviewItem })));
    // The words come from the row the RPC wrote — the actor's real name, the actor's real reason.
    expect(t).toContain("Resolved — distinct");
    expect(t).toContain("Nimali Perera");
    expect(t).toContain("two separate deliveries, both invoiced");
    expect(t).toMatch(/terminal decision is immutable/i);
    // And a resolved review offers no decision buttons.
    expect(t).not.toContain("Confirm it is a duplicate");
  });

  it("the rendered card cannot show a decision the database did not record", async () => {
    // The inverse assertion: a row still `open` must never render as resolved, whatever else is on
    // it. This is what stops a screen from reassuring somebody that work is finished.
    const { row } = await seedAndRead();
    const t = text(renderToStaticMarkup(createElement(ReviewCardView, { item: row })));
    expect(row.state).toBe("open");
    expect(row.resolution).toBeNull();
    expect(t).not.toMatch(/Resolved —/);
    expect(t).not.toMatch(/terminal decision is immutable/i);
  });
});
