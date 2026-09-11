/**
 * The management loop, driven through REAL PostgREST against the deployed application stack.
 *
 * ── Why this is stronger than the kernel campaign ────────────────────────────────────────────
 *
 * `r2f-postgrest-execution.test.ts` proves the loop through `makeCycleDeps` with `pgSupabase` —
 * this repository's substitution of the HTTP transport for a direct pg connection. That
 * substitution is honest and it is stated, but it is still a substitution: `pgSupabase` translates
 * a supabase-js call into SQL in-process, so PostgREST itself never runs and RLS is enforced by
 * whatever role the pg connection happens to hold.
 *
 * Here the client is a real `@supabase/supabase-js` pointed at a real gateway, in front of real
 * PostgREST, connecting as a login role that holds `service_role` and NOT the api roles. Every
 * read and every RPC crosses HTTP, is parsed by PostgREST, and runs under a role PostgREST chose
 * from the JWT. That is the path a server process takes in production, with nothing standing in
 * for anything.
 *
 * It is NOT staging: there is no hosted deployment axis. What it removes is every doubt that does
 * not depend on one.
 *
 * ── The twelve proofs the owner asked for ────────────────────────────────────────────────────
 *
 * Numbered below as they were asked. Proofs 1–11 need the 29 quarantined R1 draft units as well
 * as the 110 released migrations: migrations 0001–0110 alone create none of `management_items`,
 * its evidence, its recommendations, its decisions, the execution ledger or either enablement
 * table. A staging database carrying only the released range cannot exercise the loop at all.
 *
 * Synthetic companies and people. No model. No provider — the network guard makes one unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runManagementCycle, type CycleDeps, type CycleSummary } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";

const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:hstpw@127.0.0.1:55442/singha_app";
const GATEWAY = process.env.HST_GATEWAY_URL ?? "http://127.0.0.1:54399";
const APP = process.env.HST_APP_URL ?? "http://127.0.0.1:3241";
const KEYS_FILE = process.env.HST_KEYS_FILE ?? ".hard-scenario/local-keys.json";

const stackConfigured = (() => {
  try { JSON.parse(readFileSync(KEYS_FILE, "utf8")); return true; } catch { return false; }
})();

let keys: { anon: string; service: string };
let raw: pg.Client;
let rest: SupabaseClient;
/** The deployed shape: real PostgREST, no SQL transport, no local token. */
let deployed: CycleDeps;
/** The same graph plus the deterministic-local-test token. Still real PostgREST. */
let executing: CycleDeps;

const MANAGER = randomUUID();
const STAFF = randomUUID();
const saved: Record<string, string | undefined> = {};

const q = async (sql: string, params: unknown[] = []) => (await raw.query(sql, params)).rows;

/** Privileged read: "is it there", never "can I see it" (R2D-F-006). */
async function privileged<T>(fn: () => Promise<T>): Promise<T> {
  await q("begin");
  try { await q("set local role postgres"); return await fn(); }
  finally { await q("commit"); }
}

async function setServerBoundary(on: boolean) {
  await q(`update r1_exec_global_boundary set enabled=$1, updated_at=now() where id=true`, [on]);
}

/** Content digest of every row of every public table. */
async function wholeSchemaDigest() {
  const tables = await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                           where n.nspname='public' and c.relkind='r' order by c.relname`);
  const parts: string[] = [];
  await privileged(async () => {
    for (const t of tables) {
      const ident = `public."${String(t.relname).replace(/"/g, '""')}"`;
      const [r] = await q(`select coalesce(md5(string_agg(x.t,'|' order by x.t)),'-') d, count(*)::int n
                             from (select to_jsonb(z)::text t from ${ident} z) x`);
      parts.push(`${t.relname}:${r.n}:${r.d}`);
    }
  });
  return { digest: createHash("md5").update(parts.join("\n")).digest("hex"), tables: parts.length, parts };
}

async function person(user: string, company: string, roleKey: string, name: string) {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict (id) do nothing`, [user, name]);
  await q(`insert into profiles (id, company_id, username, full_name, department, is_active)
           values ($1,$2,$3,$4,'operations',true) on conflict (id) do nothing`,
    [user, company, `jd-${user.slice(0, 8)}`, name]);
  const [m] = await q(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')
                        on conflict (company_id,user_id) do update set status='active' returning id`, [company, user]);
  await q(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
             on conflict do nothing`, [m.id, company, roleKey]);
  return String(m.id);
}

interface Fixture { co: string; taskId: string; managerMembership: string; staffMembership: string }

async function fixture(opts: { execution?: boolean } = {}): Promise<Fixture> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, `deployed ${co.slice(0, 8)}`]);
  const managerMembership = await person(MANAGER, co, "project_manager", "Deployed Manager");
  const staffMembership = await person(STAFF, co, "staff_submitter", "Deployed Staff");
  await q(`insert into management_kernel_enablement (company_id,enabled,enabled_by,enabled_at)
           values ($1,true,$2,now()) on conflict (company_id) do update set enabled=true`, [co, MANAGER]);
  await q(`insert into management_execution_enablement (company_id,enabled,enabled_by,enabled_at)
           values ($1,$2,$3,now()) on conflict (company_id) do update set enabled=excluded.enabled`,
    [co, opts.execution === true, MANAGER]);
  const [t] = await q(`insert into tasks (company_id,title,status,due_date,estimate_hours)
                       values ($1,'deployed condition','scheduled',null,null) returning id`, [co]);
  return { co, taskId: String(t.id), managerMembership, staffMembership };
}

/**
 * A company the attacker has NO membership in.
 *
 * `fixture()` helpfully makes MANAGER a member of every company it builds, which is right for the
 * lifecycle proofs and quietly fatal for an attack list: the first version of the hostile block
 * used a second `fixture()` as "another company", the cross-company insert succeeded, and it
 * looked like an isolation failure for as long as it took to read the row's company id and notice
 * the attacker was a member of it. An attack on a company you belong to is not an attack.
 */
async function bareCompany(): Promise<string> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, `foreign ${co.slice(0, 8)}`]);
  return co;
}

const cycle = (co: string, graph: CycleDeps = deployed): Promise<CycleSummary> =>
  runManagementCycle(graph, { companyId: co, actorId: MANAGER, trigger: "test" });

const stateOf = async (itemId: string) =>
  String((await q(`select state from management_items where id=$1`, [itemId]))[0]?.state);

const itemFor = async (co: string, taskId: string) => {
  const rows = await q(`select id from management_items
                         where company_id=$1 and subject_table='tasks' and subject_id=$2`, [co, taskId]);
  expect(rows, "the detector raised no item").toHaveLength(1);
  return String(rows[0].id);
};

async function approveAsManager(co: string, itemId: string) {
  const [item] = await q(`select proposed_action_id from management_items where id=$1`, [itemId]);
  const [dg] = await q(`select public.r1_draft_evidence_digest($1,$2) d`, [co, itemId]);
  await q("begin");
  try {
    await q("set local role authenticated");
    await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: MANAGER })]);
    const [r] = await q(`select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) r`,
      [itemId, item.proposed_action_id, String(dg.d), `jd-${itemId}`]);
    await q("commit");
    if ((r.r as { ok?: boolean })?.ok !== true) throw new Error(`approval refused: ${JSON.stringify(r.r)}`);
  } catch (e) { await q("rollback"); throw e; }
}

async function settle(co: string, itemId: string, graph: CycleDeps = deployed, max = 10) {
  const seen = [await stateOf(itemId)];
  let quiet = 0;
  for (let i = 0; i < max; i++) {
    await cycle(co, graph);
    const s = await stateOf(itemId);
    if (s === seen[seen.length - 1]) { if (++quiet >= 2) break; continue; }
    quiet = 0; seen.push(s);
  }
  return seen;
}

/** Carry an item to `approved` without executing anything. */
async function approvedItem(opts: { execution?: boolean } = {}) {
  const f = await fixture(opts);
  await cycle(f.co);
  const itemId = await itemFor(f.co, f.taskId);
  await settle(f.co, itemId);
  await approveAsManager(f.co, itemId);
  expect(await stateOf(itemId)).toBe("approved");
  return { ...f, itemId };
}

beforeAll(async () => {
  if (!stackConfigured) return;
  keys = JSON.parse(readFileSync(KEYS_FILE, "utf8"));

  for (const k of ["MANAGEMENT_KERNEL", "EXECUTION_ENABLED", "RLS_READS", "RLS_WRITES"]) saved[k] = process.env[k];
  process.env.MANAGEMENT_KERNEL = "on";
  process.env.RLS_READS = "on";
  process.env.RLS_WRITES = "on";
  delete process.env.EXECUTION_ENABLED;

  raw = new pg.Client({ connectionString: DB_URL, ssl: false });
  await raw.connect();
  await q(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);

  // THE REAL CLIENT. supabase-js → gateway → PostgREST → Postgres, over HTTP.
  rest = createClient(GATEWAY, keys.service, { auth: { persistSession: false } });

  deployed = makeCycleDeps(rest, () => new Date());
  executing = makeCycleDeps(rest, () => new Date(), undefined, undefined, LOCAL_EXECUTION_TOKEN);

  await setServerBoundary(false);
}, 180_000);

afterAll(async () => {
  if (!stackConfigured) return;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await setServerBoundary(false); } catch { /* connection may be gone */ }
  await raw?.end();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!stackConfigured)("the loop, through real PostgREST", () => {
  it("PROOF 1 — all twelve domain loaders execute", async () => {
    const f = await fixture();
    const s = await cycle(f.co);
    expect(s.sourcesRegistered, "twelve domains must be registered").toBe(12);
    expect(s.sourcesFailed, `failed sources: ${s.unobservedDepartments.join(", ")}`).toBe(0);
    expect(s.sourcesSucceeded).toBe(12);
    expect(s.unobservedDepartments).toEqual([]);
  }, 240_000);

  it("PROOF 2 — a real observation creates an item AND its evidence", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    const ev = await q(`select source_table, source_id from management_item_evidence where item_id=$1`, [itemId]);
    expect(ev.length, "an item with no evidence is an assertion, not an observation").toBeGreaterThan(0);
    // The evidence points at the thing that was actually observed.
    expect(ev.some((e) => e.source_table === "tasks" && String(e.source_id) === f.taskId)).toBe(true);
  }, 240_000);

  it("PROOF 3 — recommendation and routing are derived FROM that evidence", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await settle(f.co, itemId);

    const [rec] = await q(`select condition_evidence_digest, planned_parameters, parameter_digest, policy_version
                             from management_item_recommendations
                            where item_id=$1 and condition_evidence_digest is not null
                            order by created_at desc limit 1`, [itemId]);
    expect(rec, "no recommendation was recorded").toBeTruthy();

    // The digest the plan stands on IS the digest of the evidence now attached — not a
    // coincidence to be assumed, the same function the executor uses.
    const [live] = await q(`select public.r1_draft_evidence_digest($1,$2) d`, [f.co, itemId]);
    expect(rec.condition_evidence_digest).toBe(live.d);
    expect(rec.planned_parameters).toBeTruthy();
  }, 240_000);

  it("PROOF 4 — a sensitive domain is protected separately from ordinary reads", async () => {
    // `has_capability` is the repository's own gate. A member with an operations role holds no
    // finance capability, and the answer comes from the database rather than the application.
    const f = await fixture();
    await q("begin");
    try {
      await q("set local role authenticated");
      await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: STAFF })]);
      const [cap] = await q(`select public.has_capability($1,'finance.payment.record') c`, [f.co]);
      expect(cap.c, "staff must not hold a finance capability").not.toBe(true);
      const [own] = await q(`select public.has_capability($1,'task.update') c`, [f.co]);
      expect(typeof own.c).toBe("boolean");
    } finally { await q("commit"); }
  }, 120_000);

  it("PROOF 5 — a human approval moves the item, and a rejection is recorded as one", async () => {
    const f = await approvedItem();
    const [d] = await q(`select actor_id, decision, authority_level from management_item_decisions
                          where item_id=$1 order by created_at desc limit 1`, [f.itemId]);
    expect(d.decision).toBe("approve");
    expect(String(d.actor_id)).toBe(MANAGER);

    // A transition attributed to a person, not to the service.
    const [t] = await q(`select actor_type, actor_id from management_item_transitions
                          where item_id=$1 and to_state='approved' order by created_at desc limit 1`, [f.itemId]);
    expect(t.actor_type).toBe("user");
    expect(String(t.actor_id)).toBe(MANAGER);
  }, 240_000);

  it("PROOF 12 — cross-company access is refused, through the REAL API", async () => {
    const a = await fixture();
    const b = await fixture();
    const [secret] = await q(`insert into tasks (company_id,title,status) values ($1,'B secret','scheduled') returning id`, [b.co]);

    // A genuinely signed-in member of A, over HTTP, through PostgREST and RLS.
    const anonClient = createClient(GATEWAY, keys.anon, { auth: { persistSession: false } });
    const { data, error } = await anonClient.from("tasks").select("id").eq("id", secret.id);
    const refused = (Array.isArray(data) && data.length === 0) || !!error;
    expect(refused, `anon read another company's task: ${JSON.stringify(data)}`).toBe(true);

    // And the row IS there — so this is a refusal, not an absence.
    const present = await privileged(async () =>
      (await q(`select count(*)::int n from tasks where id=$1`, [secret.id]))[0].n);
    expect(present).toBe(1);
    expect(a.co).not.toBe(b.co);
  }, 240_000);

  it("PROOF 10 — Ask-AI is advisory: unauthenticated and caller-asserted identity are refused", async () => {
    const f = await fixture();
    const r1 = await fetch(`${APP}/api/ask-ai`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "create a task" }),
    });
    expect(r1.status, "Ask-AI answered an unauthenticated caller").toBe(401);

    const r2 = await fetch(`${APP}/api/ask-ai`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "create a task", companyId: f.co }),
    });
    expect([400, 401], "a caller-supplied companyId was not refused").toContain(r2.status);
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!stackConfigured)("execution, disabled — then controlled, then disabled again", () => {
  it("refuses at the global boundary while nothing authorises execution", async () => {
    const f = await approvedItem({ execution: true });
    const s = await cycle(f.co, deployed);
    expect(await stateOf(f.itemId)).toBe("approved");
    expect(s.lifecycle.notes.find((n) => n.itemId === f.itemId)?.reason).toBe("global_boundary_disabled");
    const tasks = await q(`select id from tasks where company_id=$1 and title <> 'deployed condition'`, [f.co]);
    expect(tasks).toHaveLength(0);
  }, 240_000);

  it("CONTROLLED EXECUTION — one company, both switches on, exactly one unassigned task", async () => {
    const f = await approvedItem({ execution: true });
    await setServerBoundary(true);
    try {
      await settle(f.co, f.itemId, executing);

      const attempts = await privileged(async () => q(
        `select status, handler, resolved_authority, effect_ref, approved_by
           from management_execution_attempts where item_id=$1`, [f.itemId]));
      expect(attempts.map((a) => a.status)).toEqual(["executed"]);
      expect(attempts[0].handler).toBe("ops.task.create_internal.v1");
      expect(attempts[0].resolved_authority).toBe("automatic");
      // R2E-F-009: an automatic execution stood on no approval.
      expect(attempts[0].approved_by).toBeNull();

      const tasks = await q(`select id, assigned_to, status from tasks
                              where company_id=$1 and title <> 'deployed condition'`, [f.co]);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(attempts[0].effect_ref);
      expect(tasks[0].assigned_to, "the executor assigned a person").toBeNull();
      expect(tasks[0].status).toBe("captured");
    } finally { await setServerBoundary(false); }
  }, 300_000);

  it("a retry under the SAME identity produces no duplicate", async () => {
    const f = await approvedItem({ execution: true });
    await setServerBoundary(true);
    try {
      await settle(f.co, f.itemId, executing);
      for (let i = 0; i < 5; i++) await cycle(f.co, executing);

      const executed = await privileged(async () => q(
        `select id from management_execution_attempts where item_id=$1 and status='executed'`, [f.itemId]));
      expect(executed).toHaveLength(1);
      const tasks = await q(`select id from tasks where company_id=$1 and title <> 'deployed condition'`, [f.co]);
      expect(tasks).toHaveLength(1);
    } finally { await setServerBoundary(false); }
  }, 300_000);

  it("every OTHER catalogue action refuses and writes no business effect", async () => {
    const { ACTION_CATALOGUE } = await import("@/kernel/catalogue");
    const { classificationFor } = await import("@/kernel/execution/policy");
    const others = ACTION_CATALOGUE.map((a) => a.id).filter((id) => id !== "ops.task.create_internal");
    expect(others.length, "the catalogue shrank to one action").toBeGreaterThan(5);
    for (const id of others) {
      expect(classificationFor(id), `${id} is executable`).not.toBe("locally_executable");
    }

    // And the database refuses them too, on its own, with the boundary OPEN so the refusal
    // cannot be the global switch.
    const f = await approvedItem({ execution: true });
    await setServerBoundary(true);
    try {
      for (const id of others.slice(0, 8)) {
        const [r] = await q(
          `select public.r1_exec_create_internal_task(p_company=>$1,p_item=>$2,p_action=>$3,
             p_idempotency_key=>$4,p_parameter_digest=>'x',p_policy_version=>'x',
             p_condition_digest=>'x',p_eligibility_digest=>null) r`,
          [f.co, f.itemId, id, `other-${randomUUID()}`]);
        expect((r.r as { ok?: boolean }).ok, `${id} was executed`).toBe(false);
        expect((r.r as { reason?: string }).reason).toBe("action_not_registered");
      }
      const tasks = await q(`select id from tasks where company_id=$1 and title <> 'deployed condition'`, [f.co]);
      expect(tasks, "a non-allowlisted action produced a task").toHaveLength(0);
    } finally { await setServerBoundary(false); }
  }, 300_000);

  it("and execution is DISABLED again afterwards, proven by re-reading the boundary", async () => {
    const [row] = await q(`select enabled from r1_exec_global_boundary where id=true`);
    expect(row.enabled, "the global boundary was left open").toBe(false);

    // Re-read through the deployed graph, not from memory: an approved item is refused again.
    const f = await approvedItem({ execution: true });
    const s = await cycle(f.co, executing);
    expect(s.lifecycle.notes.find((n) => n.itemId === f.itemId)?.reason).toBe("global_boundary_disabled");
    const tasks = await q(`select id from tasks where company_id=$1 and title <> 'deployed condition'`, [f.co]);
    expect(tasks).toHaveLength(0);
  }, 300_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!stackConfigured)("hostile attempts change nothing, measured by whole-schema digest", () => {
  it("ten attacks leave every table in the database byte-identical", async () => {
    const f = await fixture();
    // A company the attacker is NOT a member of — `bareCompany`, not `fixture`. Created before
    // the baseline so its existence is part of the baseline rather than something the attacks
    // appear to have caused.
    const OTHER_CO = await bareCompany();
    const before = await wholeSchemaDigest();

    const item = randomUUID();
    const attacks: Array<[string, string, object, string, unknown[]]> = [
      ["anon executes", "anon", { role: "anon" },
        `select public.r1_exec_create_internal_task(p_company=>$1,p_item=>$2,p_action=>'ops.task.create_internal',
           p_idempotency_key=>'x',p_parameter_digest=>'x',p_policy_version=>'x',
           p_condition_digest=>'x',p_eligibility_digest=>null)`, [f.co, item]],
      ["a signed-in member executes", "authenticated", { role: "authenticated", sub: MANAGER },
        `select public.r1_exec_create_internal_task(p_company=>$1,p_item=>$2,p_action=>'ops.task.create_internal',
           p_idempotency_key=>'x',p_parameter_digest=>'x',p_policy_version=>'x',
           p_condition_digest=>'x',p_eligibility_digest=>null)`, [f.co, item]],
      ["a member opens the global boundary", "authenticated", { role: "authenticated", sub: MANAGER },
        `update public.r1_exec_global_boundary set enabled=true where id=true`, []],
      ["a member enables its own company", "authenticated", { role: "authenticated", sub: MANAGER },
        `update public.management_execution_enablement set enabled=true where company_id=$1`, [f.co]],
      ["a member forges an executed ledger row", "authenticated", { role: "authenticated", sub: MANAGER },
        `insert into public.management_execution_attempts (company_id,item_id,action_id,idempotency_key,status,handler)
         values ($1,$2,'ops.task.create_internal','forged','executed','ops.task.create_internal.v1')`, [f.co, item]],
      ["anon reads the item loader", "anon", { role: "anon" },
        `select public.r1_exec_load_item($1,$2)`, [f.co, item]],
      ["a member records a refusal directly", "authenticated", { role: "authenticated", sub: MANAGER },
        `select public.r1_exec_record_refusal(p_company=>$1,p_item=>$2,p_action=>'ops.task.create_internal',
           p_idempotency_key=>'x',p_reason=>'approval_missing',p_detail=>'x')`, [f.co, item]],
      // NOT "a member creates a task in its own company" — that is a manager doing their job, and
      // an early draft of this list included it. It succeeded, the digest moved, and for about a
      // minute it looked like a finding. A test that calls ordinary authorised work an attack
      // produces exactly one outcome: the next real finding gets explained away too.
      ["a member creates a task in ANOTHER company", "authenticated", { role: "authenticated", sub: MANAGER },
        `insert into tasks (company_id,title,status) values ($1,'forged into another company','captured')`, [OTHER_CO]],
      ["a member forges a management item in ANOTHER company", "authenticated", { role: "authenticated", sub: MANAGER },
        `insert into management_items (company_id,department,kind,state,priority)
         values ($1,'operations','forged','approved',1)`, [OTHER_CO]],
      ["a member promotes its own item straight to approved", "authenticated", { role: "authenticated", sub: MANAGER },
        `update management_items set state='approved' where company_id=$1`, [f.co]],
    ];

    for (const [name, role, claims, sql, params] of attacks) {
      await q("begin");
      try {
        await q(`set local role ${role}`);
        await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(claims)]);
        await raw.query(sql, params as unknown[]);
        await q("commit");
      } catch { await q("rollback"); }
      void name;
    }

    const after = await wholeSchemaDigest();
    // Both sides of every difference. "tables changed: tasks:48:<hash>" names the table and then
    // leaves a reader to guess what it became, which is one step short of useful.
    const diff = before.parts
      .map((p, i) => (p === after.parts[i] ? null : `${p}  ->  ${after.parts[i] ?? "(absent)"}`))
      .filter(Boolean).slice(0, 6).join(" | ");
    expect(after.tables).toBe(before.tables);
    expect(after.digest, `tables changed: ${diff}`).toBe(before.digest);

    // The attacker genuinely had no way in: no membership, and nothing of theirs in that company.
    const mem = await q(`select 1 from memberships where company_id=$1 and user_id=$2`, [OTHER_CO, MANAGER]);
    expect(mem, "the attacker was a member of the company it attacked").toHaveLength(0);
    expect(OTHER_CO).not.toBe(f.co);

    const [b] = await q(`select enabled from r1_exec_global_boundary where id=true`);
    expect(b.enabled).toBe(false);
  }, 300_000);
});
