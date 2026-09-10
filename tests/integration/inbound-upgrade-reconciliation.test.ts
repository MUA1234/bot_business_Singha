/**
 * FOUND-003 correction — the UPGRADE path over databases that already hold the duplicate rows.
 *
 * Migrations 0069–0076 are unreleased, but disposable and developer databases hold the `in_`/`evt_`
 * pairs the defect produced. This suite builds its OWN database at 0075, seeds the exact shapes the
 * defective implementation created, applies 0076, and checks what the reconciliation did:
 *
 *   * a provable pair leaves the capture canonical and marks the receipt `superseded` WITH a link;
 *   * a pair whose receipt is referenced downstream is NOT superseded — it is left visible;
 *   * contradictory content hashes are not "proved" equivalent;
 *   * an unpaired receipt is not turned into consumer work;
 *   * NOTHING is deleted;
 *   * the sweeper skips superseded rows and still claims the legacy captures.
 *
 * It creates a database, so it runs only against a LOCAL disposable server — never a hosted one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const URL = process.env.DATABASE_URL ?? "";
const isLocal = /(?:localhost|127\.0\.0\.1)/.test(URL);
const enabled = !!URL && isLocal;
const rnd = () => Math.random().toString(36).slice(2, 10);

/* eslint-disable @typescript-eslint/no-explicit-any */
let admin: any, db: any;
const DBNAME = `recon_${Date.now().toString(36)}`;
let co: string;

const migrations = () =>
  readdirSync("src/db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

/** Apply the migrations in (afterExclusive, lastInclusive]. Re-running an applied one is not idempotent. */
async function applyRange(client: any, afterExclusive: number, lastInclusive: number) {
  for (const f of migrations()) {
    const n = Number(f.slice(0, 4));
    if (n <= afterExclusive || n > lastInclusive) continue;
    await client.query(readFileSync(`src/db/migrations/${f}`, "utf8"));
  }
}

describe.skipIf(!enabled)("0076 — upgrade reconciliation of existing in_/evt_ pairs (live, own database)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const adminUrl = URL.replace(/\/[^/]*$/, "/postgres");
    admin = new pg.Client({ connectionString: adminUrl, ssl: false });
    await admin.connect();
    await admin.query(`create database ${DBNAME}`);

    db = new pg.Client({ connectionString: URL.replace(/\/[^/]*$/, `/${DBNAME}`), ssl: false });
    await db.connect();
    await db.query(readFileSync("tests/integration/helpers/supabase-shim.sql", "utf8"));
    await applyRange(db, 0, 75);
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('recon','LKR') returning id`)).rows[0].id;

    const seed = async (key: string, msgId: string, company: string | null, hash: string | null) =>
      (await db.query(
        `insert into source_events (source, provider_message_id, company_id, raw_payload, content_hash, idempotency_key, correlation_id, status)
         values ('whatsapp',$1,$2,'{"receivedBy":"acct-1"}'::jsonb,$3,$4,$5,'received') returning id`,
        [msgId, company, hash, key, `cor_${rnd()}`],
      )).rows[0].id;

    // (a) a PROVABLE pair — the exact shape the defect produced
    (globalThis as any).__pairReceipt = await seed("in_aaa", "wamid.PAIR", null, "h1");
    (globalThis as any).__pairCapture = await seed("evt_aaa", "wamid.PAIR", co, "h1");
    // (b) a pair whose RECEIPT is referenced downstream
    (globalThis as any).__refReceipt = await seed("in_bbb", "wamid.REF", null, "h2");
    (globalThis as any).__refCapture = await seed("evt_bbb", "wamid.REF", co, "h2");
    await db.query(
      `insert into inbound_reviews (company_id, source_event_id, channel, provider_message_id, reason_code)
       values ($1,$2,'whatsapp','wamid.REF','staff_other')`, [co, (globalThis as any).__refReceipt]);
    // (c) CONTRADICTORY hashes — equivalence is not provable
    (globalThis as any).__badReceipt = await seed("in_ccc", "wamid.BAD", null, "h3");
    (globalThis as any).__badCapture = await seed("evt_ccc", "wamid.BAD", co, "DIFFERENT");
    // (d) an UNPAIRED receipt — a customer order that was never captured
    (globalThis as any).__lone = await seed("in_ddd", "wamid.LONE", null, "h4");
    // (e) an unpaired capture — genuine consumer work
    (globalThis as any).__capture = await seed("evt_eee", "wamid.CAP", co, "h5");

    await applyRange(db, 75, 76);
  }, 120_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    try { await admin.query(`drop database if exists ${DBNAME} with (force)`); } catch { /* noop */ }
    await admin?.end().catch(() => {});
  });

  const row = async (id: string) =>
    (await db.query(`select dispatch_state, dispatch_outcome, superseded_by, status, event_identity, provider_account_id from source_events where id=$1`, [id])).rows[0];

  it("NOTHING was deleted — every seeded row survives the reconciliation", async () => {
    const ids = ["__pairReceipt", "__pairCapture", "__refReceipt", "__refCapture", "__badReceipt", "__badCapture", "__lone", "__capture"]
      .map((k) => (globalThis as any)[k] as string);
    const found = (await db.query(`select id from source_events where id = any($1::uuid[])`, [ids])).rows.map((r: any) => r.id);
    expect(found.sort()).toEqual([...ids].sort());
  });

  it("a PROVABLE pair: the capture is canonical, the receipt is superseded WITH a link", async () => {
    const receipt = await row((globalThis as any).__pairReceipt);
    const capture = await row((globalThis as any).__pairCapture);
    expect(receipt.dispatch_state).toBe("superseded");
    expect(receipt.superseded_by).toBe((globalThis as any).__pairCapture);
    expect(receipt.status).toBe("duplicate");
    expect(capture.dispatch_state).toBe("dispatched");
    expect(capture.dispatch_outcome).toBe("staff_finance");
    expect(capture.superseded_by).toBeNull();
  });

  it("a pair whose receipt is REFERENCED downstream is left visible, not superseded", async () => {
    const receipt = await row((globalThis as any).__refReceipt);
    expect(receipt.dispatch_state).toBe("manual_review");
    expect(receipt.dispatch_outcome).toBe("duplicate_receipt_with_downstream_references");
    expect(receipt.superseded_by).toBeNull();
  });

  it("CONTRADICTORY content hashes are not proven equivalent", async () => {
    const receipt = await row((globalThis as any).__badReceipt);
    expect(receipt.dispatch_state).not.toBe("superseded");
    expect(receipt.superseded_by).toBeNull();
  });

  it("an UNPAIRED receipt is not turned into consumer work", async () => {
    const lone = await row((globalThis as any).__lone);
    expect(lone.dispatch_state).toBe("dispatched");
    expect(lone.dispatch_outcome).toBe("legacy_receipt");
  });

  it("the receiving account is recovered from the stored payload, and identities are stamped", async () => {
    const capture = await row((globalThis as any).__capture);
    expect(capture.provider_account_id).toBe("acct-1");
    expect(capture.event_identity).toBe("ev1:whatsapp:acct-1:wamid.CAP:inbound_message");
  });

  it("a legacy collision leaves the later row WITHOUT an identity rather than failing the upgrade", async () => {
    // in_aaa and evt_aaa share (channel, account, provider message id): only one can hold the
    // canonical identity, and the other keeps working — it simply does not deduplicate.
    const a = await row((globalThis as any).__pairReceipt);
    const b = await row((globalThis as any).__pairCapture);
    const withIdentity = [a.event_identity, b.event_identity].filter(Boolean);
    expect(withIdentity).toHaveLength(1);
  });

  it("the sweeper claims the legacy captures and SKIPS the superseded receipt", async () => {
    const claimed = (await db.query(`select id from public.claim_source_events(50,'recon_sweeper',120)`)).rows.map((r: any) => r.id);
    expect(claimed).toContain((globalThis as any).__capture);
    expect(claimed).toContain((globalThis as any).__pairCapture);
    expect(claimed).not.toContain((globalThis as any).__pairReceipt);  // superseded
    expect(claimed).not.toContain((globalThis as any).__lone);         // never a capture
    expect(claimed).not.toContain((globalThis as any).__refReceipt);   // parked for a person
  });

  it("company-scoped health excludes the superseded row", async () => {
    const b = (await db.query(`select * from public.source_event_backlog($1)`, [co])).rows[0];
    // The superseded receipt has no company, and the ones that do are the captures.
    expect(Number(b.dispatch_manual_review)).toBe(0); // the referenced receipt has company_id null
    expect(Number(b.pending) + Number(b.processing)).toBeGreaterThan(0);
  });
});
