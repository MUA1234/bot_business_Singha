/**
 * Migration 0069 — durable inbound processing, against a LIVE disposable PostgreSQL.
 *
 * These tests exist because the verification campaign had to RETRACT a claim that a failed inbound
 * message "is retried". Nothing retried it. The rule adopted then still applies: do not claim retry
 * exists until an executable path actually retries. This file is that proof.
 *
 * Fairness is the subtle one. The old mechanism was ordering, which cannot work: a permanently
 * failing row sorts to the same place every run and occupies a batch slot forever. Here fairness is
 * ELIGIBILITY — a failed row's `next_attempt_at` moves into the future under bounded backoff, so it
 * stops competing, and once attempts are exhausted it dead-letters and never competes again.
 *
 * Everything is synthetic. Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let admin: any, wA: any, wB: any, authed: any;
let coA: string, coB: string;

const SERVICE = `select set_config('request.jwt.claims', '{"role":"service_role"}', false)`;
const AUTHED = `select set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111"}', false)`;

/** Insert a synthetic inbound event, optionally already eligible/waiting. */
async function seed(company: string, over: Record<string, unknown> = {}): Promise<string> {
  const cols: Record<string, unknown> = {
    source: "whatsapp",
    provider_message_id: `wamid_${randomUUID()}`,
    company_id: company,
    raw_payload: JSON.stringify({ synthetic: true }),
    idempotency_key: `idem_${randomUUID()}`,
    correlation_id: `cor_${randomUUID().slice(0, 8)}`,
    status: "pending",
    ...over,
  };
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 1}`).join(",");
  const r = await admin.query(
    `insert into source_events (${keys.join(",")}) values (${vals}) returning id`,
    keys.map((k) => cols[k]),
  );
  return r.rows[0].id;
}

const claim = (c: any, owner: string, limit = 10) =>
  c.query(`select id, attempts, status, lease_owner from claim_source_events($1,$2,$3)`, [limit, owner, 120]);

// Lifecycle at module scope: two describe blocks share these clients, so an afterAll inside the
// first block would close them before the second block ran.
if (enabled) {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => {
      const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
      await c.connect();
      return c;
    };
    admin = await mk(); wA = await mk(); wB = await mk(); authed = await mk();
    for (const c of [admin, wA, wB]) await c.query(SERVICE);
    await authed.query(AUTHED);
    coA = (await admin.query(`insert into companies (name, base_currency) values ('dur_A','LKR') returning id`)).rows[0].id;
    coB = (await admin.query(`insert into companies (name, base_currency) values ('dur_B','LKR') returning id`)).rows[0].id;
  });

  afterAll(async () => {
    for (const co of [coA, coB]) {
      try { await admin.query(`delete from source_events where company_id=$1`, [co]); } catch { /* noop */ }
      try { await admin.query(`delete from companies where id=$1`, [co]); } catch { /* noop */ }
    }
    await Promise.all([wA?.end(), wB?.end(), authed?.end(), admin?.end()].map((p: any) => p?.catch?.(() => {})));
  });
}

describe.skipIf(!enabled)("0069 durable inbound processing (live DB)", () => {
  it("two workers claiming concurrently never receive the same row", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(await seed(coA));

    const [a, b] = await Promise.all([claim(wA, "worker-A", 20), claim(wB, "worker-B", 20)]);
    const aIds = a.rows.map((r: any) => r.id);
    const bIds = b.rows.map((r: any) => r.id);

    expect(new Set([...aIds, ...bIds]).size).toBe(aIds.length + bIds.length); // disjoint
    expect(aIds.length + bIds.length).toBeGreaterThan(0);
    for (const id of [...aIds, ...bIds]) expect(ids.has(id)).toBe(true);

    await admin.query(`delete from source_events where company_id=$1`, [coA]);
  });

  it("a claim increments attempts, so a crashing worker still consumes one", async () => {
    const id = await seed(coA);
    const c1 = await claim(wA, "worker-A", 5);
    expect(c1.rows.find((r: any) => r.id === id)?.attempts).toBe(1);

    // Worker "crashes": never completes, never fails. Expire the lease as time would.
    await admin.query(`update source_events set lease_expires_at = now() - interval '1 minute' where id=$1`, [id]);

    const c2 = await claim(wB, "worker-B", 5);
    const again = c2.rows.find((r: any) => r.id === id);
    expect(again).toBeTruthy();
    expect(again.attempts).toBe(2); // recovered AND counted — a poison row cannot loop forever
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("an unexpired lease is NOT reclaimable by another worker", async () => {
    const id = await seed(coA);
    await claim(wA, "worker-A", 5);
    const c2 = await claim(wB, "worker-B", 5);
    expect(c2.rows.find((r: any) => r.id === id)).toBeUndefined();
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("only the lease holder may complete or fail the row", async () => {
    const id = await seed(coA);
    await claim(wA, "worker-A", 5);

    await expect(wB.query(`select complete_source_event($1,$2)`, [id, "worker-B"])).rejects.toThrow();
    await expect(wB.query(`select fail_source_event($1,$2,'e','boom',5)`, [id, "worker-B"])).rejects.toThrow();

    const ok = await wA.query(`select complete_source_event($1,$2) as v`, [id, "worker-A"]);
    expect(ok.rows[0].v).toBe(true);
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("completion is idempotent", async () => {
    const id = await seed(coA);
    await claim(wA, "worker-A", 5);
    await wA.query(`select complete_source_event($1,$2)`, [id, "worker-A"]);
    const second = await wA.query(`select complete_source_event($1,$2) as v`, [id, "worker-A"]);
    expect(second.rows[0].v).toBe(true);
    const row = await admin.query(`select status, processed_at from source_events where id=$1`, [id]);
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].processed_at).not.toBeNull();
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("failure applies bounded exponential backoff and is not immediately reclaimable", async () => {
    const id = await seed(coA);
    await claim(wA, "worker-A", 5);
    const out = await wA.query(`select fail_source_event($1,$2,'transient','boom',5) as v`, [id, "worker-A"]);
    expect(out.rows[0].v).toBe("retry_wait");

    const row = await admin.query(`select status, next_attempt_at > now() as waiting from source_events where id=$1`, [id]);
    expect(row.rows[0].status).toBe("retry_wait");
    expect(row.rows[0].waiting).toBe(true);

    // Not eligible yet — this is what stops a failing row from occupying every batch.
    const c = await claim(wA, "worker-A", 20);
    expect(c.rows.find((r: any) => r.id === id)).toBeUndefined();
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("backoff is deterministic and capped at one hour", async () => {
    const r = await admin.query(
      `select inbound_backoff_seconds(1) a, inbound_backoff_seconds(2) b, inbound_backoff_seconds(3) c, inbound_backoff_seconds(50) d`,
    );
    expect(r.rows[0].a).toBe(30);
    expect(r.rows[0].b).toBe(60);
    expect(r.rows[0].c).toBe(120);
    expect(r.rows[0].d).toBe(3600);
  });

  it("a poison row dead-letters once attempts are exhausted, and is never claimed again", async () => {
    const id = await seed(coA);
    let last = "";
    for (let i = 0; i < 5; i++) {
      await admin.query(`update source_events set next_attempt_at = now() - interval '1 hour' where id=$1`, [id]);
      const c = await claim(wA, "worker-A", 5);
      expect(c.rows.find((r: any) => r.id === id)).toBeTruthy();
      last = (await wA.query(`select fail_source_event($1,$2,'poison','always fails',5) as v`, [id, "worker-A"])).rows[0].v;
    }
    expect(last).toBe("dead_letter");

    const row = await admin.query(`select status, dead_lettered_at, dead_letter_reason from source_events where id=$1`, [id]);
    expect(row.rows[0].status).toBe("dead_letter");
    expect(row.rows[0].dead_lettered_at).not.toBeNull();
    expect(row.rows[0].dead_letter_reason).toContain("always fails");

    await admin.query(`update source_events set next_attempt_at = now() - interval '1 hour' where id=$1`, [id]);
    const c = await claim(wA, "worker-A", 50);
    expect(c.rows.find((r: any) => r.id === id)).toBeUndefined();
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("unauthorized roles cannot claim, complete, fail or read backlog", async () => {
    const id = await seed(coA);
    for (const sql of [
      [`select * from claim_source_events(1,'x',60)`, []],
      [`select complete_source_event($1,'x')`, [id]],
      [`select fail_source_event($1,'x','e','m',5)`, [id]],
      [`select * from source_event_backlog($1)`, [coA]],
    ] as [string, any[]][]) {
      await expect(authed.query(sql[0], sql[1])).rejects.toThrow();
    }
    await admin.query(`delete from source_events where id=$1`, [id]);
  });

  it("backlog counts are company-scoped and refuse an unscoped call", async () => {
    await seed(coA);
    await seed(coA);
    await seed(coB);

    const a = await admin.query(`select * from source_event_backlog($1)`, [coA]);
    const b = await admin.query(`select * from source_event_backlog($1)`, [coB]);
    expect(Number(a.rows[0].pending)).toBe(2);
    expect(Number(b.rows[0].pending)).toBe(1);

    await expect(admin.query(`select * from source_event_backlog(null)`)).rejects.toThrow();
    await admin.query(`delete from source_events where company_id = any($1::uuid[])`, [[coA, coB]]);
  });
});

describe.skipIf(!enabled)("0069 fairness beyond 200 rows", () => {
  it("a poison row cannot occupy every batch while newer eligible work waits", async () => {
    // 250 rows: more than the old 200-row window, which is where the campaign's starvation defect
    // lived. One of them fails forever.
    const poison = await seed(coA, { received_at: new Date(Date.now() - 86_400_000).toISOString() });
    const fresh: string[] = [];
    for (let i = 0; i < 250; i++) fresh.push(await seed(coA));

    const processed = new Set<string>();
    let poisonAttempts = 0;

    // Ten sweeper passes of 25. A fair mechanism drains the backlog; an unfair one keeps handing
    // back the same poison row.
    for (let pass = 0; pass < 10; pass++) {
      const batch = await claim(wA, "sweeper", 25);
      for (const row of batch.rows) {
        if (row.id === poison) {
          poisonAttempts++;
          await wA.query(`select fail_source_event($1,$2,'poison','always fails',5)`, [row.id, "sweeper"]);
        } else {
          await wA.query(`select complete_source_event($1,$2)`, [row.id, "sweeper"]);
          processed.add(row.id);
        }
      }
    }

    // The poison row backs off, so it appears at most a couple of times across ten passes — it can
    // never be every slot of every batch, which was the pre-0069 behaviour.
    expect(poisonAttempts).toBeLessThanOrEqual(2);
    // …and the newer work actually got through.
    expect(processed.size).toBeGreaterThanOrEqual(200);

    const stuck = await admin.query(
      `select count(*)::int n from source_events where company_id=$1 and id <> $2 and status <> 'completed'`,
      [coA, poison],
    );
    expect(stuck.rows[0].n).toBeLessThanOrEqual(50); // remaining backlog is ordinary, not starvation
    await admin.query(`delete from source_events where company_id=$1`, [coA]);
    expect(fresh.length).toBe(250);
  }, 120_000);

  it("multiple companies both receive processing opportunity in one sweep", async () => {
    for (let i = 0; i < 30; i++) await seed(coA);
    for (let i = 0; i < 30; i++) await seed(coB);

    const batch = await claim(wA, "sweeper", 60);
    const rows = await admin.query(
      `select company_id, count(*)::int n from source_events where id = any($1::uuid[]) group by company_id`,
      [batch.rows.map((r: any) => r.id)],
    );
    expect(rows.rows).toHaveLength(2); // neither company is starved by the other

    await admin.query(`delete from source_events where company_id = any($1::uuid[])`, [[coA, coB]]);
  }, 60_000);

  it("an expired lease becomes eligible again after a worker restart", async () => {
    const id = await seed(coA);
    await claim(wA, "worker-before-restart", 5);
    await admin.query(`update source_events set lease_expires_at = now() - interval '5 minutes' where id=$1`, [id]);

    const after = await claim(wB, "worker-after-restart", 5);
    expect(after.rows.find((r: any) => r.id === id)).toBeTruthy();
    await admin.query(`delete from source_events where id=$1`, [id]);
  });
});
