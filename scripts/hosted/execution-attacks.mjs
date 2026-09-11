#!/usr/bin/env node
/**
 * Adversarial campaign against the execution boundary, measured by WHOLE-SCHEMA CONTENT DIGEST.
 *
 * ── Why a digest, when the suites already assert "no task was created" ───────────────────────
 *
 * `r2f-postgrest-adversarial.test.ts` ends every attack by counting tasks and ledger rows. That
 * answers "did the thing I expected to happen, happen?" — and an attack is interesting precisely
 * when it does something the author did not think to count. A hostile call that wrote a row into
 * `audit_events`, or flipped `management_items.state`, or left a `management_task_idempotency`
 * key spent, would pass every assertion in that file.
 *
 * So this measures differently. It takes a content digest of EVERY row of EVERY application table
 * — read privileged, with RLS out of the way, because a policy that hides a row makes "was not
 * written" and "cannot be seen" indistinguishable (R2D-F-006) — then runs the attacks, then takes
 * the digest again. The two must be identical. Not "the tables I thought to check": all of them.
 *
 * ── What is deliberately NOT attacked ────────────────────────────────────────────────────────
 *
 * Nothing hosted. The script refuses a non-loopback `DATABASE_URL`, and it creates and destroys
 * its own database inside whatever local server that points at.
 *
 * Usage:
 *   DATABASE_URL=postgres://…@127.0.0.1:PORT/postgres node scripts/hosted/execution-attacks.mjs
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error("DATABASE_URL is required (point it at the maintenance database)"); process.exit(2); }
if (!/127\.0\.0\.1|localhost|\[::1\]/.test(ADMIN)) {
  console.error("REFUSED: this script creates and destroys databases, so it runs only against a LOCAL server.");
  process.exit(2);
}

const DB = `singha_exec_attacks_${Date.now().toString(36)}`;
const urlFor = (db) => { const u = new URL(ADMIN); u.pathname = `/${db}`; return u.toString(); };

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const admin = new pg.Client({ connectionString: ADMIN, ssl: false });
await admin.connect();

let db;
let code = 1;
try {
  console.log(`▶ building ${DB} …`);
  await admin.query(`drop database if exists "${DB}" with (force)`);
  await admin.query(`create database "${DB}"`);
  const url = urlFor(DB);

  const sh = (cmd, args, env = {}) =>
    execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, DATABASE_URL: url, ...env } });

  sh("node", ["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"]);
  // One runner, one chain. The draft step this used to need went away when 001–030 were
  // promoted to 0111–0140.
  sh("node", ["scripts/migrate.mjs"]);

  db = new pg.Client({ connectionString: url, ssl: false });
  await db.connect();

  // ── The digest ────────────────────────────────────────────────────────────────────────────
  //
  // Every ordinary table in `public`, every row, as text, ordered — then one md5 over the lot.
  // Reading each table's rows as a single `to_jsonb(t)::text` avoids naming columns, so a table
  // gaining a column does not silently drop out of the measurement.
  async function wholeSchemaDigest() {
    const { rows: tables } = await db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by c.relname`);
    const parts = [];
    await db.query("begin");
    try {
      // PRIVILEGED. "Is it there", never "can I see it".
      await db.query("set local role postgres");
      for (const t of tables) {
        // The table name comes from `pg_class`, not from anything a caller supplied, and is
        // still quoted — a relation called `"; drop …"` is legal in PostgreSQL and this script
        // is about not being surprised.
        const ident = `public."${t.relname.replace(/"/g, '""')}"`;
        const { rows } = await db.query(
          `select coalesce(md5(string_agg(x.t, '|' order by x.t)), '-') as d, count(*)::int as n
             from (select to_jsonb(q)::text as t from ${ident} q) x`,
        );
        parts.push(`${t.relname}:${rows[0].n}:${rows[0].d}`);
      }
    } finally { await db.query("commit"); }
    const { rows } = await db.query(`select md5($1) as d`, [parts.join("\n")]);
    return { digest: rows[0].d, tables: parts.length, detail: parts };
  }

  // ── A company, a person, an approved item: the only state the attacks may legitimately see ──
  const CO = randomUUID(), USER = randomUUID();
  await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  await db.query(`insert into companies (id,name,base_currency) values ($1,'attack co','LKR')`, [CO]);
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [USER]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,'attacker',true)`, [USER]);
  await db.query(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [CO, USER]);
  await db.query(
    `insert into management_execution_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,true,$2,now())`, [CO, USER]);

  const before = await wholeSchemaDigest();
  console.log(`▶ baseline digest ${before.digest} over ${before.tables} tables`);

  // ── The attacks ───────────────────────────────────────────────────────────────────────────
  //
  // Each one is a call a hostile caller could make. None of them may change anything at all.
  const ITEM = randomUUID();
  const attacks = [
    ["anon calls the execute", "anon", { role: "anon" },
      `select public.r1_exec_create_internal_task(p_company => $1, p_item => $2,
         p_action => 'ops.task.create_internal', p_idempotency_key => 'x',
         p_parameter_digest => 'x', p_policy_version => 'x',
         p_condition_digest => 'x', p_eligibility_digest => null)`, [CO, ITEM]],

    ["a signed-in member calls the execute", "authenticated", { role: "authenticated", sub: USER },
      `select public.r1_exec_create_internal_task(p_company => $1, p_item => $2,
         p_action => 'ops.task.create_internal', p_idempotency_key => 'x',
         p_parameter_digest => 'x', p_policy_version => 'x',
         p_condition_digest => 'x', p_eligibility_digest => null)`, [CO, ITEM]],

    ["anon reads the item loader", "anon", { role: "anon" },
      `select public.r1_exec_load_item($1,$2)`, [CO, ITEM]],

    ["a signed-in member reads the approval loader", "authenticated", { role: "authenticated", sub: USER },
      `select public.r1_exec_load_approval($1,$2,'ops.task.create_internal')`, [CO, ITEM]],

    ["a signed-in member asks for its own capabilities", "authenticated", { role: "authenticated", sub: USER },
      `select public.r1_exec_approver_capabilities($1,$2)`, [CO, USER]],

    ["anon opens the global boundary", "anon", { role: "anon" },
      `update public.r1_exec_global_boundary set enabled = true where id = true`, []],

    ["a signed-in member opens the global boundary", "authenticated", { role: "authenticated", sub: USER },
      `update public.r1_exec_global_boundary set enabled = true where id = true`, []],

    ["a signed-in member enables its own company for execution", "authenticated", { role: "authenticated", sub: USER },
      `update public.management_execution_enablement set enabled = true where company_id = $1`, [CO]],

    ["anon records a refusal", "anon", { role: "anon" },
      `select public.r1_exec_record_refusal(p_company => $1, p_item => $2,
         p_action => 'ops.task.create_internal', p_idempotency_key => 'x',
         p_reason => 'approval_missing', p_detail => 'x')`, [CO, ITEM]],

    ["a signed-in member writes the execution ledger directly", "authenticated", { role: "authenticated", sub: USER },
      `insert into public.management_execution_attempts
         (company_id, item_id, action_id, idempotency_key, status, handler)
       values ($1,$2,'ops.task.create_internal','forged','executed','ops.task.create_internal.v1')`,
      [CO, ITEM]],

    ["service_role calls the execute with the boundary shut", "service_role", { role: "service_role" },
      `select public.r1_exec_create_internal_task(p_company => $1, p_item => $2,
         p_action => 'ops.task.create_internal', p_idempotency_key => 'x',
         p_parameter_digest => 'x', p_policy_version => 'x',
         p_condition_digest => 'x', p_eligibility_digest => null)`, [CO, ITEM]],

    // The boundary is OPEN for this one, so the refusal cannot be the global switch. It is the
    // item: there is none. A caller who can pass the switches still cannot invent a subject.
    ["service_role executes an item that does not exist, boundary OPEN", "service_role", { role: "service_role" },
      `select public.r1_exec_create_internal_task(p_company => $1, p_item => $2,
         p_action => 'ops.task.create_internal', p_idempotency_key => 'x',
         p_parameter_digest => 'x', p_policy_version => 'x',
         p_condition_digest => 'x', p_eligibility_digest => null)`, [CO, ITEM], { open: true }],
  ];

  for (const [name, role, claims, sql, params, opts] of attacks) {
    if (opts?.open) {
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      await db.query(`update public.r1_exec_global_boundary set enabled = true where id = true`);
    }
    let outcome = "";
    await db.query("begin");
    try {
      await db.query(`set local role ${role}`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const r = await db.query(sql, params);
      await db.query("commit");
      // A write that RLS filtered to nothing does not error — it reports zero rows, and "returned
      // null" hid that. The command tag and the row count say which happened.
      outcome = r.command === "SELECT"
        ? `returned ${JSON.stringify(r.rows[0] ?? null).slice(0, 90)}`
        : `${r.command} affected ${r.rowCount} row(s)`;
    } catch (e) {
      await db.query("rollback");
      outcome = `refused: ${e.message.split("\n")[0].slice(0, 80)}`;
    }
    if (opts?.open) {
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      await db.query(`update public.r1_exec_global_boundary set enabled = false where id = true`);
    }
    console.log(`  · ${name} → ${outcome}`);
  }

  // ── The measurement ───────────────────────────────────────────────────────────────────────
  const after = await wholeSchemaDigest();
  console.log(`▶ digest after attacks ${after.digest} over ${after.tables} tables`);

  check(`${attacks.length} hostile execution attempts changed NOTHING in the whole schema`,
    before.digest === after.digest,
    before.digest === after.digest ? "" : firstDifference(before.detail, after.detail));

  check("the measurement covers the execution tables it exists to watch", [
    "tasks", "management_execution_attempts", "management_items",
    "management_task_idempotency", "r1_exec_global_boundary", "audit_events",
  ].every((t) => after.detail.some((d) => d.startsWith(`${t}:`))));

  check("the global execution boundary is still SHUT after every attack",
    (await db.query(`select enabled from public.r1_exec_global_boundary where id = true`)).rows[0].enabled === false);

  code = fail === 0 ? 0 : 1;
} catch (e) {
  console.error(e.message ?? e);
  code = 1;
} finally {
  await db?.end();
  await admin.query(`drop database if exists "${DB}" with (force)`).catch(() => {});
  await admin.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(code);

/** Which table's content moved — far more useful than "the digests differ". */
function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `first change: ${a[i] ?? "(absent)"} → ${b[i] ?? "(absent)"}`;
  }
  return "digests differ but no per-table line does — the table LIST changed";
}
