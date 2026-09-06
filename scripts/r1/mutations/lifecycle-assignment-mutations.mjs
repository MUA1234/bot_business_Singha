/**
 * Mutation harness for the lifecycle orchestrator and the assignment boundary.
 *
 * The suites pass. That is not evidence they would notice if a guard were removed, so each
 * mutation below removes exactly one and the campaign is re-run against a real database.
 *
 * The list is the owner's: a model advancing state, a service impersonating a user, an automatic
 * action setting the accountable owner, a manager assigning outside scope, an assignee /
 * accountable-owner mismatch, a stale candidate assignment, approval executing directly,
 * assignment without a created task, concurrent different assignees, a skipped transition,
 * overwritten history, the automatic path applied to another catalogue action, and execution
 * success treated as business resolution.
 *
 * Verdicts are parsed from the summary line of a real campaign. The ANSI strip removes the whole
 * escape sequence INCLUDING the ESC byte — stripping only the bracket part makes the "failed"
 * pattern unmatchable and reports every mutation as SURVIVED.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { takeMutationLock } from "./guard.mjs";

// Held for the whole run. The pre-commit hook refuses while it exists, because a commit taken
// mid-campaign captures a deliberately broken boundary rather than the code under test.
takeMutationLock("lifecycle-assignment-mutations.mjs");

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const NL = String.fromCharCode(10);

const ORCH = "src/kernel/orchestrator.ts";
const DEPS = "src/kernel/cycle-deps.ts";
const SQL = "src/db/draft-migrations-r1/R1_DRAFT_028_lifecycle_and_assignment.up.sql";
const FILES = [ORCH, DEPS, SQL];

for (const f of FILES) copyFileSync(f, `${f}.bak`);
const restore = () => { for (const f of FILES) copyFileSync(`${f}.bak`, f); };

function sub(file, from, to) {
  const s = readFileSync(file, "utf8");
  if (!s.includes(from)) throw new Error(`anchor missing in ${file}: ${from.slice(0, 70)}`);
  writeFileSync(file, s.replace(from, () => to), "utf8");
}

const MUTATIONS = [
  {
    id: "L1 the orchestrator records its advances as a PERSON's act",
    apply: () =>
      sub(DEPS, `              p_actor: null,
              p_actor_type: "system",`,
        `              p_actor: null,
              p_actor_type: "user", // MUTATION`),
  },
  {
    id: "L2 the automatic path is opened to every catalogue action",
    apply: () =>
      sub(ORCH, `      if (!item.effectCreated && item.actionId === AUTOMATIC_ACTION_ID && item.hasPlan) {`,
        `      if (!item.effectCreated && item.hasPlan) { // MUTATION`),
  },
  {
    id: "L3 an item with no evidence is advanced anyway",
    apply: () =>
      sub(ORCH, `      if (item.evidenceCount < 1) {`, `      if (false) { // MUTATION`),
  },
  {
    id: "L4 an item with no usable action is advanced to recommended",
    apply: () =>
      sub(ORCH, `      if (!actionIsUsable(item.actionId)) {`, `      if (false) { // MUTATION`),
  },
  {
    id: "L5 an approval-requiring item skips straight to approved",
    apply: () =>
      sub(ORCH, `      if (!isAutomaticItem(item)) {
        return legal(`, `      if (false) { // MUTATION
        return legal(`),
  },
  {
    id: "L6 assigned → monitoring ignores the assignee/owner mismatch",
    apply: () =>
      sub(ORCH, `      if (item.accountableUserId !== item.taskAssignee) {`,
        `      if (false) { // MUTATION`),
  },
  {
    id: "L7 the database lets any item skip approval",
    apply: () =>
      sub(SQL, `  if p_from = 'recommended' and p_to in ('approved', 'assigned') then`,
        `  if false then -- MUTATION`),
  },
  {
    id: "A1 the assigner's capability is not checked",
    apply: () =>
      sub(SQL, `  if not public.has_capability(v_company, 'operations.task.manage') then`,
        `  if false then -- MUTATION`),
  },
  {
    id: "A2 the TARGET's capability is not checked",
    apply: () =>
      sub(SQL, `  if not exists (
    select 1
      from public.membership_roles mr
      join public.role_permissions rp on rp.role_key = mr.role_key
     where mr.membership_id = v_target.id
       and rp.permission_key = 'operations.task.work'
  ) then`, `  if false then -- MUTATION`),
  },
  {
    id: "A3 an ended membership may be assigned work",
    apply: () =>
      sub(SQL, `  if v_target.status is distinct from 'active' then`, `  if false then -- MUTATION`),
  },
  {
    id: "A4 approved leave is ignored",
    apply: () =>
      sub(SQL, `         and l.status = 'approved'`, `         and l.status = 'never-a-status' -- MUTATION`),
  },
  {
    id: "A5 the candidate's eligibility evidence is not revalidated",
    apply: () =>
      sub(SQL, `    if v_rec.eligibility_evidence_digest is distinct from p_expected_eligibility_digest then`,
        `    if false then -- MUTATION`),
  },
  {
    id: "A6 an override needs no reason",
    apply: () =>
      sub(SQL, `    if coalesce(btrim(p_override_reason), '') = '' then
      select candidate_ref into v_rec`,
        `    if false then -- MUTATION
      select candidate_ref into v_rec`),
  },
  {
    id: "A7 the item's accountable owner is written WITHOUT the task's assignee",
    apply: () =>
      sub(SQL, `  update public.tasks set assigned_to = v_target.user_id where id = v_task_id;
  update public.management_items set accountable_owner_id = v_target.id where id = p_item_id;`,
        `  update public.management_items set accountable_owner_id = v_target.id where id = p_item_id; -- MUTATION`),
  },
  {
    id: "A8 assignment proceeds with no created effect",
    apply: () =>
      sub(SQL, `  if v_task_id is null then`, `  if false then -- MUTATION`),
  },
  {
    id: "A9 the item is not locked, so two managers can both assign",
    apply: () =>
      sub(SQL, `   where id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  v_company := v_item.company_id;`,
        `   where id = p_item_id; -- MUTATION
  if not found then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  v_company := v_item.company_id;`),
  },
  {
    id: "A10 a conflicting retry returns the first assignment",
    apply: () =>
      sub(SQL, `      if v_existing.membership_id = p_membership_id and v_existing.assigned_by_user_id = v_actor then`,
        `      if true then -- MUTATION`),
  },
  {
    id: "A11 service_role may execute the assignment RPC",
    apply: () =>
      sub(SQL, `  foreach v_role in array array['anon', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function %s from %I', sig, v_role);
    end if;
  end loop;`,
        `  foreach v_role in array array['anon'] loop -- MUTATION
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function %s from %I', sig, v_role);
    end if;
  end loop;`),
  },
  {
    id: "A12 assignment history may be overwritten",
    apply: () =>
      sub(SQL, `create trigger mia_no_update
  before update or delete on management_item_assignments
  for each row execute function r1_draft_assignments_append_only();`,
        `-- MUTATION: trigger not created`),
  },
];

const ORCH_SUITE = "tests/integration/r2-lifecycle-orchestrator.test.ts";
const ASSIGN_SUITE = "tests/integration/r2-assignment-boundary.test.ts";

/**
 * Each mutation runs against the suite that SHOULD catch it, not against both.
 *
 * Running both every time would be more thorough on paper and nearly three hours slower on a host
 * already five times its quiet-run baseline — and a mutation caught by the wrong suite would be a
 * weaker result anyway, because it would not show that the guard is defended where it lives.
 */
const suiteFor = (id) => (id.startsWith("L") ? ORCH_SUITE : ASSIGN_SUITE);

const results = [];
for (const m of MUTATIONS) {
  restore();
  try {
    m.apply();
  } catch (e) {
    results.push({ id: m.id, verdict: "INCONCLUSIVE", detail: `could not apply: ${e.message}` });
    console.log(`INCONCLUSIVE ${m.id}`);
    continue;
  }

  let out = "";
  try {
    out = execSync("node scripts/r1/run-r1-security-tests.mjs", {
      env: { ...process.env, R1_SEC_ONLY: suiteFor(m.id) },
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const plain = out.replace(ANSI, "");
  const summary = plain.split(NL).find((l) => /\bTests\b/.test(l) && /passed|failed/.test(l));
  const failed = summary ? summary.match(/(\d+)\s+failed/) : null;
  const passed = summary ? summary.match(/(\d+)\s+passed/) : null;

  let verdict;
  let detail;
  if (!summary || (!failed && !passed)) {
    // A mutation that stops the MIGRATION applying, or a harness that could not start a database,
    // never reaches a test. Calling that "caught" would credit the suite with a detection it never
    // made.
    verdict = "INCONCLUSIVE";
    detail = /database never became ready/.test(plain)
      ? "the harness could not start a database (host contention)"
      : "no parsed Tests line — the campaign did not run the suite";
  } else if (failed) {
    verdict = "CAUGHT";
    detail = `${failed[1]} failed`;
  } else {
    verdict = "SURVIVED";
    detail = `${passed[1]} passed, 0 failed`;
  }
  results.push({ id: m.id, verdict, detail });
  console.log(`${verdict.padEnd(12)} ${m.id} - ${detail}`);
}

restore();
console.log(`${NL}=== SUMMARY ===`);
for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.id} - ${r.detail}`);
const bad = results.filter((r) => r.verdict !== "CAUGHT");
console.log(bad.length ? `${NL}${bad.length} mutation(s) NOT caught` : `${NL}all mutations caught`);
