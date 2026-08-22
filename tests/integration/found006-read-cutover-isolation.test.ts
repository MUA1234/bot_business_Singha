/**
 * FOUND-006 — page read-path cutover isolation.
 *
 * The admin/HR pages and price-request component migrated in this slice now read
 * through `supabaseReadClient()`, which returns the authenticated RLS-bound client
 * when `RLS_READS=on`. This test proves the underlying policies enforce company
 * isolation for every table those pages touch.
 *
 * It is a ZERO-PERSISTENCE test: all setup runs inside a transaction that is rolled
 * back in afterAll. Each statement runs in a savepoint so an expected RLS denial does
 * not abort the outer transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let companyA: string, companyB: string, userA: string, userB: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try {
    const r = await client.query(sql, params);
    await client.query("release savepoint s");
    return r;
  } catch (e) {
    await client.query("rollback to savepoint s");
    throw e;
  }
}

async function asUser(userId: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
}

async function asSuperuser() {
  await client.query("reset role");
}

describe.skipIf(!enabled)("FOUND-006 — read-cutover pages are company-isolated by RLS", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");

    const co = async (name: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [name])).rows[0].id;
    companyA = await co("found006_A");
    companyB = await co("found006_B");

    userA = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'found006_uA',true) returning id`)).rows[0].id;
    userB = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'found006_uB',true) returning id`)).rows[0].id;

    await client.query(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active'),($3,$4,'active')`,
      [companyA, userA, companyB, userB],
    );

    // auth.users is the referenced side of profiles.id; users is the app-side identity table.
    await q(`insert into auth.users (id) values ($1),($2) on conflict do nothing`, [userA, userB]);

    // Profiles mirror the migrated HR pages' primary read table.  is_admin + sales/finance
    // department satisfies the read policies for the admin/price-request surfaces while still
    // being bound to the user's own company by RLS.
    await q(
      `insert into profiles (id, company_id, username, department, is_admin, is_active, skills, annual_leave_days)
       values ($1,$2,'a_user','sales',true,true,array[]::text[],21),($3,$4,'b_user','sales',true,true,array[]::text[],21)`,
      [userA, companyA, userB, companyB],
    );

    // Audit events (admin audit page).
    await q(
      `insert into audit_events (company_id, actor_type, action, entity_type, created_at)
       values ($1,'user','test.action','test_entity',now()),($2,'user','test.action','test_entity',now())`,
      [companyA, companyB],
    );

    // Objectives (admin objectives page).
    await q(
      `insert into objectives (company_id, title, target_value, current_value, status, created_at)
       values ($1,'A objective',1,0,'on_track',now()),($2,'B objective',1,0,'on_track',now())`,
      [companyA, companyB],
    );

    // Message outbox (admin outbox page).
    await q(
      `insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts, template_lang, created_at)
       values ($1,'whatsapp','9471','body-a',$3,'pending',0,'en',now()),($2,'whatsapp','9472','body-b',$4,'pending',0,'en',now())`,
      [companyA, companyB, `idem-a-${Date.now()}`, `idem-b-${Date.now()}`],
    );

    // Product catalog (admin catalog page).
    await q(
      `insert into product_catalog (company_id, name, currency, is_active, created_at)
       values ($1,'A product','LKR',true,now()),($2,'B product','LKR',true,now())`,
      [companyA, companyB],
    );

    // Quotations + orders (admin home page + price requests component).
    await q(
      `insert into quotations (company_id, quote_number, currency, status, subtotal, tax_amount, total, public_token, created_at)
       values ($1,'QA-001','LKR','draft',0,0,0,$3,now()),($2,'QB-001','LKR','draft',0,0,0,$4,now())`,
      [companyA, companyB, `tok-a-${Date.now()}`, `tok-b-${Date.now()}`],
    );
    await q(
      `insert into orders (company_id, customer_name, status, created_at, updated_at)
       values ($1,'A customer','new',now(),now()),($2,'B customer','new',now(),now())`,
      [companyA, companyB],
    );

    // Tasks (HR capacity page).
    await q(
      `insert into tasks (company_id, title, status, priority, requires_evidence, created_at, updated_at)
       values ($1,'A task','captured',1,false,now(),now()),($2,'B task','captured',1,false,now(),now())`,
      [companyA, companyB],
    );

    // Capacity snapshots (HR home page).
    const memA = (await q(`select id from memberships where company_id=$1 and user_id=$2`, [companyA, userA])).rows[0].id;
    const memB = (await q(`select id from memberships where company_id=$1 and user_id=$2`, [companyB, userB])).rows[0].id;
    await q(
      `insert into capacity_snapshots (company_id, membership_id, week_start, total_hours, net_capacity_hours, allocated_hours, available_hours, status, created_at)
       values ($1,$2,current_date,40,36,10,26,'healthy',now()),($3,$4,current_date,40,36,10,26,'healthy',now())`,
      [companyA, memA, companyB, memB],
    );

    // Leave requests (HR home + employee record pages).
    await q(
      `insert into leave_requests (company_id, profile_id, start_date, end_date, days, status, created_at)
       values ($1,$2,current_date,current_date,1,'pending',now()),($3,$4,current_date,current_date,1,'pending',now())`,
      [companyA, userA, companyB, userB],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it.each([
    ["audit_events", "actor_type", "user"],
    ["objectives", "title", "A objective"],
    ["message_outbox", "recipient", "9471"],
    ["product_catalog", "name", "A product"],
    ["profiles", "username", "a_user"],
    ["quotations", "quote_number", "QA-001"],
    ["orders", "customer_name", "A customer"],
    ["tasks", "title", "A task"],
    ["capacity_snapshots", "membership_id", "MEMBERSHIP_A"],
    ["leave_requests", "profile_id", "PROFILE_A"],
  ] as const)("%s — user A sees only company A rows", async (table, labelCol, expectedLabel) => {
    await asUser(userA);
    const { rows } = await q(`select company_id, ${labelCol} as label from ${table} where company_id in ($1,$2)`, [companyA, companyB]);
    await asSuperuser();

    let expected: string = expectedLabel;
    if (table === "capacity_snapshots") {
      expected = (await q(`select id from memberships where company_id=$1 and user_id=$2`, [companyA, userA])).rows[0].id;
    } else if (table === "leave_requests") {
      expected = userA;
    }

    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBe(companyA);
    expect(rows[0].label).toBe(expected);
  });

  it("price_confirmations — user A cannot see company B open confirmations", async () => {
    // Need a quotation per company; use the rows seeded above.
    const qa = (await q(`select id from quotations where company_id=$1`, [companyA])).rows[0].id;
    const qb = (await q(`select id from quotations where company_id=$1`, [companyB])).rows[0].id;
    await q(
      `insert into quotation_items (company_id, quotation_id, description, quantity, unit_price, currency, line_total)
       values ($1,$2,'item-a',1,0,'LKR',0),($3,$4,'item-b',1,0,'LKR',0)`,
      [companyA, qa, companyB, qb],
    );
    const ia = (await q(`select id from quotation_items where quotation_id=$1`, [qa])).rows[0].id;
    const ib = (await q(`select id from quotation_items where quotation_id=$1`, [qb])).rows[0].id;
    await q(
      `insert into price_confirmations (company_id, quotation_id, quotation_item_id, department, description, quantity, currency, status, created_at)
       values ($1,$2,$3,'sales','A confirm',1,'LKR','open',now()),($4,$5,$6,'sales','B confirm',1,'LKR','open',now())`,
      [companyA, qa, ia, companyB, qb, ib],
    );

    await asUser(userA);
    const { rows } = await q(`select description from price_confirmations where status='open' and company_id in ($1,$2)`, [companyA, companyB]);
    await asSuperuser();
    expect(rows.length).toBe(1);
    expect(rows[0].description).toBe("A confirm");
  });
});
