/**
 * R2D — retention deletes CONTENT, not merely visibility.
 *
 * The previous purge test was a FALSE PASS. It asserted that expired guidance no longer appeared
 * through ordinary queries — but RLS hides expired rows from `SELECT` regardless of whether
 * anything was deleted, so the assertion held while the data sat in the table untouched. The
 * write-guard trigger was returning NEW on DELETE, which is NULL for a delete, and a BEFORE
 * trigger returning NULL silently skips the operation: every delete on these tables was being
 * discarded without an error, a warning, or a changed row count.
 *
 * So every assertion here reads through a PRIVILEGED connection with RLS explicitly bypassed. The
 * question is not "can I still see it" but "is it still there".
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const STAFF = randomUUID();
const B_STAFF = randomUUID();

let raw: pg.Client;
let membershipA = "";
let membershipB = "";

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/**
 * Count rows with RLS explicitly out of the way.
 *
 * `SELECT` policies hide expired threads, so an ordinary read cannot distinguish "deleted" from
 * "hidden" — which is exactly how the earlier test passed while nothing was being deleted.
 */
async function physicalCount(table: string, where: string, params: unknown[]): Promise<number> {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(`select count(*)::int as n from ${table} where ${where}`, params);
    return rows[0].n as number;
  } finally {
    await q("rollback");
  }
}

async function seedThread(
  companyId: string, membershipId: string, expiresIn: string | null,
): Promise<{ threadId: string; turnId: string }> {
  const { rows: th } = await q(
    `insert into ask_ai_threads (company_id, membership_id, language) values ($1,$2,'en')
     returning id`, [companyId, membershipId]);
  const threadId = th[0].id as string;
  if (expiresIn) {
    await q(`update ask_ai_threads set expires_at = now() ${expiresIn} where id=$1`, [threadId]);
  }
  await q(`insert into ask_ai_turns (thread_id, company_id, role, content, language)
           values ($1,$2,'user','a question','en')`, [threadId, companyId]);
  const { rows: t } = await q(
    `insert into ask_ai_turns (thread_id, company_id, role, content, language, confidence)
     values ($1,$2,'assistant','an answer','en',0.8) returning id`, [threadId, companyId]);
  const turnId = t[0].id as string;
  await q(`insert into ask_ai_citations (turn_id, company_id, source_table, source_id)
           values ($1,$2,'tasks',$3)`, [turnId, companyId, randomUUID()]);
  await q(`insert into ask_ai_suggested_actions (turn_id, company_id, action_id)
           values ($1,$2,'operations.task.flag_for_review')`, [turnId, companyId]);
  return { threadId, turnId };
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await q("begin");
  try {
    await q(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ role: "authenticated", sub: userId })]);
    await q("set local role authenticated");
    return await fn();
  } finally {
    await q("rollback");
  }
}

describe.skipIf(!enabled)("R2D — the purge removes content, not just visibility", () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    for (const co of [CO_A, CO_B]) {
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
        [co, `purge ${co.slice(0, 8)}`]);
    }
    for (const [u, name, co] of [[STAFF, "Purge Staff", CO_A], [B_STAFF, "B Staff", CO_B]] as const) {
      await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
      await q(`insert into users (id, full_name, is_active) values ($1,$2,true)
               on conflict (id) do nothing`, [u, name]);
    }
    const { rows: a } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
      [CO_A, STAFF]);
    membershipA = a[0].id as string;
    const { rows: b } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`,
      [CO_B, B_STAFF]);
    membershipB = b[0].id as string;
  }, 180_000);

  afterAll(async () => { await raw?.end(); });

  it("PHYSICALLY deletes an expired thread's turns", async () => {
    const { threadId } = await seedThread(CO_A, membershipA, "- interval '2 days'");
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId])).toBe(2);

    await q(`select r1_draft_ask_ai_purge_expired()`);

    // The decisive read: privileged, RLS bypassed. "Not visible" is not "not there".
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId]),
      "expired turns are still stored").toBe(0);
  }, 180_000);

  it("RLS hiding a row is explicitly NOT accepted as purge evidence", async () => {
    // The false pass, reproduced deliberately: expire a thread WITHOUT purging. An ordinary read
    // sees nothing; the rows are all still there. Any test that stopped at the first assertion
    // would report a working purge.
    const { threadId } = await seedThread(CO_A, membershipA, "- interval '3 days'");

    const visible = await asUser(STAFF, async () =>
      (await q(`select id from ask_ai_threads where id=$1`, [threadId])).rows.length);
    expect(visible, "an expired thread was still visible").toBe(0);

    expect(await physicalCount("ask_ai_threads", "id=$1", [threadId]),
      "the thread was gone before any purge ran").toBe(1);
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId])).toBe(2);
  }, 180_000);

  it("child citations and suggested actions go with the turns", async () => {
    const { threadId, turnId } = await seedThread(CO_A, membershipA, "- interval '2 days'");
    expect(await physicalCount("ask_ai_citations", "turn_id=$1", [turnId])).toBe(1);

    await q(`select r1_draft_ask_ai_purge_expired()`);

    expect(await physicalCount("ask_ai_citations", "turn_id=$1", [turnId]),
      "citations outlived the turn they belong to").toBe(0);
    expect(await physicalCount("ask_ai_suggested_actions", "turn_id=$1", [turnId])).toBe(0);
    void threadId;
  }, 180_000);

  it("an ACTIVE thread is untouched", async () => {
    const { threadId } = await seedThread(CO_A, membershipA, null);
    await q(`select r1_draft_ask_ai_purge_expired()`);
    expect(await physicalCount("ask_ai_threads", "id=$1", [threadId]),
      "a live thread was purged").toBe(1);
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId])).toBe(2);
  }, 180_000);

  it("is IDEMPOTENT — running it twice removes nothing extra and raises nothing", async () => {
    const { threadId } = await seedThread(CO_A, membershipA, "- interval '2 days'");
    const first = await q(`select r1_draft_ask_ai_purge_expired() as n`);
    const second = await q(`select r1_draft_ask_ai_purge_expired() as n`);
    expect(Number(first.rows[0].n)).toBeGreaterThan(0);
    expect(Number(second.rows[0].n)).toBe(0);
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId])).toBe(0);
  }, 180_000);

  it("reports the number of TURNS removed, not threads marked", async () => {
    // The return value is the thing a caller can verify. A count of marked threads would have
    // reported success while the content stayed.
    await seedThread(CO_A, membershipA, "- interval '2 days'");
    await seedThread(CO_A, membershipA, "- interval '2 days'");
    const { rows } = await q(`select r1_draft_ask_ai_purge_expired() as n`);
    expect(Number(rows[0].n)).toBe(4);
  }, 180_000);

  it("the DATABASE clock decides expiry, not the caller", async () => {
    const { threadId } = await seedThread(CO_A, membershipA, "+ interval '5 minutes'");
    await q(`select r1_draft_ask_ai_purge_expired()`);
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId]),
      "a thread expiring in the future was purged").toBe(2);
  }, 180_000);

  it("never crosses a company boundary", async () => {
    const a = await seedThread(CO_A, membershipA, "- interval '2 days'");
    const b = await seedThread(CO_B, membershipB, null);
    await q(`select r1_draft_ask_ai_purge_expired()`);
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [a.threadId])).toBe(0);
    expect(await physicalCount("ask_ai_turns", "thread_id=$1", [b.threadId]),
      "another company's live thread was purged").toBe(2);
  }, 180_000);

  /**
   * An ordinary user's write REACHES NOTHING.
   *
   * These tests assert the effect, not an exception, and the distinction is deliberate.
   *
   * There is no RLS policy for UPDATE or DELETE on these tables, so a caller's statement
   * matches zero rows and returns success having changed nothing. The obvious "improvement"
   * — adding permissive UPDATE/DELETE policies so the write-guard trigger fires and raises a
   * clear error — would make the TRIGGER the only thing standing between an authenticated
   * caller and another company's rows. That trades a real tenant boundary for a better error
   * message, so it is not taken.
   *
   * The security property is therefore stated as what it is: the write affects nothing and
   * the data survives unchanged. Asserting a rejection would have been asserting a nicer
   * error, not a stronger guarantee.
   */
  describe("an ordinary user cannot touch any of it", () => {
    it("cannot DELETE a thread or a turn — the write reaches no rows", async () => {
      const { threadId } = await seedThread(CO_A, membershipA, null);

      const del = await asUser(STAFF, async () =>
        q(`delete from ask_ai_threads where id=$1`, [threadId]));
      const delTurns = await asUser(STAFF, async () =>
        q(`delete from ask_ai_turns where thread_id=$1`, [threadId]));

      expect(del.rowCount, "an ordinary user deleted a thread").toBe(0);
      expect(delTurns.rowCount, "an ordinary user deleted turns").toBe(0);
      // Verified against storage, not visibility.
      expect(await physicalCount("ask_ai_threads", "id=$1", [threadId])).toBe(1);
      expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId])).toBe(2);
    }, 180_000);

    it("cannot SHORTEN, EXTEND or REVIVE an expiry", async () => {
      const { threadId } = await seedThread(CO_A, membershipA, null);
      const { rows: before } = await q(
        `select expires_at, retention_status from ask_ai_threads where id=$1`, [threadId]);

      for (const attempt of [
        `update ask_ai_threads set expires_at = now() - interval '1 day' where id=$1`,
        `update ask_ai_threads set expires_at = now() + interval '80 days' where id=$1`,
        `update ask_ai_threads set retention_status = 'active' where id=$1`,
      ]) {
        const res = await asUser(STAFF, async () => q(attempt, [threadId]));
        expect(res.rowCount, attempt).toBe(0);
      }

      // The stored expiry is byte-identical afterwards: retention cannot be moved by a user.
      const { rows: after } = await q(
        `select expires_at, retention_status from ask_ai_threads where id=$1`, [threadId]);
      expect(String(after[0].expires_at)).toBe(String(before[0].expires_at));
      expect(after[0].retention_status).toBe(before[0].retention_status);
    }, 180_000);

    it("the write-guard trigger DOES raise when a row actually reaches it", async () => {
      // The guard is not decorative: where RLS lets a row through — as it does for INSERT,
      // which has no policy either but is reached differently — the trigger refuses loudly
      // rather than silently discarding the write.
      await expect(asUser(STAFF, async () =>
        q(`insert into ask_ai_threads (company_id, membership_id) values ($1,$2)`,
          [CO_A, membershipA]))).rejects.toThrow();
    }, 180_000);

    it("cannot exceed the 90-day ceiling even as the server", async () => {
      const { threadId } = await seedThread(CO_A, membershipA, null);
      await expect(q(
        `update ask_ai_threads set expires_at = created_at + interval '120 days' where id=$1`,
        [threadId])).rejects.toThrow();
    }, 180_000);
  });

  it("a concurrent purge and read do not corrupt each other", async () => {
    const { threadId } = await seedThread(CO_A, membershipA, "- interval '2 days'");
    const other = new pg.Client({ connectionString: URL, ssl: false });
    await other.connect();
    try {
      await other.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      const [, reads] = await Promise.all([
        q(`select r1_draft_ask_ai_purge_expired()`),
        other.query(`select count(*)::int as n from ask_ai_turns where thread_id=$1`, [threadId]),
      ]);
      // Whichever order they land in, the read returns a number and neither errors.
      expect(typeof reads.rows[0].n).toBe("number");
      expect(await physicalCount("ask_ai_turns", "thread_id=$1", [threadId])).toBe(0);
    } finally {
      await other.end();
    }
  }, 180_000);

  it("safety events are NOT purged with guidance — they follow their own policy", async () => {
    // A coded redirection record is the audit trail for a protected disclosure. It has no
    // content, and it is not part of the operational history the purge clears.
    await q(`insert into ask_ai_safety_events (company_id, membership_id, category, redirected_to)
             values ($1,$2,'grievance','human_hr_or_management_channel')`, [CO_A, membershipA]);
    const before = await physicalCount("ask_ai_safety_events", "company_id=$1", [CO_A]);
    await seedThread(CO_A, membershipA, "- interval '2 days'");
    await q(`select r1_draft_ask_ai_purge_expired()`);
    expect(await physicalCount("ask_ai_safety_events", "company_id=$1", [CO_A])).toBe(before);
  }, 180_000);
});
