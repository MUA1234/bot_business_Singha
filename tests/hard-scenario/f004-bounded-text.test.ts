/**
 * F-004 — user-controlled text must be bounded at the database boundary.
 *
 * The defect: an authenticated non-admin stored a 2,000,000-character customer name
 * through the ordinary data API. Application validation cannot close that, because the
 * caller holds a legitimate JWT and can address PostgREST directly — so migration 0109
 * bounds the externally-writable surface with CHECK constraints.
 *
 * These tests exist to prove three things, in this order of importance:
 *   1. Oversized writes are REFUSED — through every path, including the privileged one.
 *   2. Nothing is silently truncated. A refused write leaves no partial record.
 *   3. Legitimate records still work — including non-Latin scripts, emoji and multiline
 *      prose, which a byte-based limit would have wrongly rejected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { stackConfigured, signInAs, serviceClient, rest, TENANT_A } from "./helpers/stack";

const MARK = "HST-F004";

describe.skipIf(!stackConfigured)("F-004 — bounded user-controlled text", () => {
  let a: Awaited<ReturnType<typeof signInAs>>;

  beforeAll(async () => {
    a = await signInAs(TENANT_A.owner);
  });

  afterAll(async () => {
    const svc = serviceClient();
    await svc.from("customers").delete().like("name", `${MARK}%`);
    await svc.from("customers").delete().like("name", "AAAA%");
  });

  async function countMatching(pattern: string): Promise<number> {
    const svc = serviceClient();
    const { data } = await svc.from("customers").select("id").like("name", pattern);
    return (data ?? []).length;
  }

  /* ── 1. Oversized writes are refused ─────────────────────────────────── */

  it("refuses a 2,000,000-character name — the original defect", async () => {
    const huge = "A".repeat(2_000_000);
    const { status } = await rest(`/customers`, a.accessToken, {
      method: "POST",
      body: JSON.stringify({ company_id: TENANT_A.company, name: huge, status: "active" }),
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(await countMatching("AAAA%"), "an oversized name was stored").toBe(0);
  });

  it("refuses a value one character over the limit, and accepts one exactly at it", async () => {
    // The boundary is where an off-by-one lives. `customers.name` is bounded at 256.
    const svc = serviceClient();

    const atLimit = `${MARK}-` + "x".repeat(256 - (MARK.length + 1));
    expect(atLimit.length).toBe(256);
    const okRes = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: atLimit, status: "active" })
      .select("id")
      .single();
    expect(okRes.error, "a value exactly at the limit was rejected").toBeNull();

    const overLimit = atLimit + "y";
    expect(overLimit.length).toBe(257);
    const badRes = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: overLimit, status: "active" })
      .select("id")
      .single();
    expect(badRes.error, "a value one over the limit was accepted").not.toBeNull();
  });

  it("refuses an oversized UPDATE, not merely an oversized INSERT", async () => {
    const svc = serviceClient();
    const { data } = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: `${MARK}-update-target`, status: "active" })
      .select("id")
      .single();
    const id = (data as { id: string }).id;

    const { status } = await rest(`/customers?id=eq.${id}`, a.accessToken, {
      method: "PATCH",
      body: JSON.stringify({ name: "B".repeat(300) }),
    });
    expect(status).toBeGreaterThanOrEqual(400);

    const { data: after } = await svc.from("customers").select("name").eq("id", id).single();
    expect((after as { name: string }).name, "the record was modified by a refused update")
      .toBe(`${MARK}-update-target`);
  });

  /* ── 2. Bypass attempts ──────────────────────────────────────────────── */

  it("the privileged service role is bound by the SAME limit", async () => {
    // A constraint that only applied to `authenticated` would be bypassed by any
    // server-side write path. This is defence in depth, not belt-and-braces.
    const svc = serviceClient();
    const { error } = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: `${MARK}` + "z".repeat(500), status: "active" })
      .select("id")
      .single();
    expect(error, "service_role bypassed the length bound").not.toBeNull();
  });

  it("a bulk import is refused as a whole — no partial row survives", async () => {
    // The realistic import bypass: hide one oversized row inside a valid batch.
    const svc = serviceClient();
    const rows = [
      { company_id: TENANT_A.company, name: `${MARK}-bulk-1`, status: "active" },
      { company_id: TENANT_A.company, name: `${MARK}-bulk-BAD-` + "q".repeat(400), status: "active" },
      { company_id: TENANT_A.company, name: `${MARK}-bulk-3`, status: "active" },
    ];
    const { error } = await svc.from("customers").insert(rows).select("id");
    expect(error, "a batch containing an oversized row was accepted").not.toBeNull();
    expect(await countMatching(`${MARK}-bulk-%`), "a partial batch was persisted").toBe(0);
  });

  it("an oversized value in a DIFFERENT column class is also refused", async () => {
    // `status` is enum-like and bounded far tighter (64) than a name.
    const svc = serviceClient();
    const { error } = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: `${MARK}-status`, status: "s".repeat(200) })
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  /* ── 3. Legitimate records still work ────────────────────────────────── */

  it("counts CHARACTERS, not bytes — non-Latin names are not penalised", async () => {
    // A byte-based limit would reject a Sinhala or Chinese name at roughly a third of
    // the length it allows an English one. That would be a bug affecting real customers
    // of this business, so it is asserted rather than assumed.
    const svc = serviceClient();
    const sinhala = "ස".repeat(200); // 200 characters, 600 bytes in UTF-8
    expect(Buffer.byteLength(sinhala, "utf8")).toBeGreaterThan(256);
    const { error } = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: `${MARK}` + sinhala.slice(0, 200), status: "active" })
      .select("id")
      .single();
    expect(error, "a 200-character non-Latin name was rejected by a byte-based limit").toBeNull();
  });

  it("accepts emoji and combining marks within the character limit", async () => {
    const svc = serviceClient();
    const name = `${MARK}-café ☕ 👨‍👩‍👧‍👦 é`;
    const { data, error } = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name, status: "active" })
      .select("id,name")
      .single();
    expect(error).toBeNull();
    expect((data as { name: string }).name, "the value was altered on the way in").toBe(name);
  });

  it("accepts multiline prose in a free-text column", async () => {
    // `description` is bounded at 8000 — generous, because people genuinely write there.
    const svc = serviceClient();
    const prose = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: placeholder note text.`).join("\n");
    expect(prose.length).toBeLessThan(8000);
    const { data, error } = await svc
      .from("tasks")
      .insert({
        company_id: TENANT_A.company,
        title: `${MARK}-multiline`,
        description: prose,
        status: "planned",
        priority: 3,
      })
      .select("id,description")
      .single();
    expect(error).toBeNull();
    expect((data as { description: string }).description).toBe(prose);
    await svc.from("tasks").delete().eq("id", (data as { id: string }).id);
  });

  /* ── 4. Coverage is complete, and stays complete ─────────────────────── */

  it("every externally-writable text column is bounded", async () => {
    // Derived from the catalogue, so a future migration that adds an unbounded
    // user-writable column fails HERE rather than in production.
    const { default: pg } = await import("pg" as string);
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
    });
    await client.connect();
    try {
      const { rows } = await client.query(`
        select col.table_name || '.' || col.column_name as ref
          from information_schema.columns col
         where col.table_schema = 'public'
           and col.data_type in ('text','character varying')
           and col.character_maximum_length is null
           and col.table_name in (
             select cl.relname from pg_policy p
               join pg_class cl on cl.oid = p.polrelid
               join pg_namespace ns on ns.oid = cl.relnamespace
              where ns.nspname='public' and p.polcmd::text in ('a','w','*')
                and has_table_privilege('authenticated', cl.oid, 'INSERT'))
           and not exists (
             select 1 from pg_constraint c
               join pg_class cl2 on cl2.oid = c.conrelid
               join pg_namespace ns2 on ns2.oid = cl2.relnamespace
              where ns2.nspname='public' and cl2.relname = col.table_name
                and c.conname = left(col.table_name || '_' || col.column_name || '_len_chk', 63))`);
      expect(rows.map((r: { ref: string }) => r.ref), "unbounded user-writable text columns").toEqual([]);
    } finally {
      await client.end();
    }
  });
});
