/**
 * Mutation harness for the completion-claim boundary.
 *
 * The suite passes. That is not evidence that it would notice if the boundary stopped working, so
 * each mutation below removes one guard and the campaign is re-run against a real database. A
 * mutation that SURVIVES means the corresponding test asserts something weaker than it appears to.
 *
 * The mutations are the ones the owner named: dropping the assignee comparison, letting the
 * accountable owner claim on the worker's behalf, letting the service role claim, accepting a
 * non-terminal task, taking the claim time from `tasks.updated_at`, and letting the claim mark the
 * item verified.
 *
 * Verdicts are parsed from the summary line of a real campaign. The ANSI strip removes the whole
 * escape sequence INCLUDING the ESC byte — stripping only the bracket part makes the "failed"
 * pattern unmatchable and reports every mutation as SURVIVED, which is how seven false SURVIVED
 * verdicts were produced once already.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const NL = String.fromCharCode(10);

const SQL = "src/db/draft-migrations-r1/R1_DRAFT_026_completion_claim.up.sql";

copyFileSync(SQL, `${SQL}.bak`);
const restore = () => copyFileSync(`${SQL}.bak`, SQL);

function sub(from, to) {
  const s = readFileSync(SQL, "utf8");
  if (!s.includes(from)) throw new Error(`anchor missing: ${from.slice(0, 70)}`);
  writeFileSync(SQL, s.replace(from, () => to), "utf8");
}

const MUTATIONS = [
  {
    id: "C1 assignee comparison removed (anyone with the capability may claim)",
    apply: () =>
      sub(
        "  if v_task.assigned_to is distinct from v_actor then",
        "  if false then -- MUTATION",
      ),
  },
  {
    id: "C2 accountable owner alone is enough (the task assignment stops mattering)",
    apply: () =>
      sub(
        "  if v_task.assigned_to is distinct from v_actor then",
        `  if not exists (
       select 1 from public.memberships m
        where m.id = v_item.accountable_owner_id and m.user_id = v_actor
     ) then -- MUTATION`,
      ),
  },
  {
    id: "C3 service_role may execute the claim RPC",
    apply: () =>
      sub(
        "  foreach v_role in array array['anon', 'service_role'] loop",
        "  foreach v_role in array array['anon'] loop -- MUTATION",
      ),
  },
  {
    id: "C4 an unfinished task may be claimed complete",
    apply: () =>
      sub(
        "  if v_task.status not in ('completed', 'cancelled') then",
        "  if v_task.status not in ('completed', 'cancelled', 'in_progress', 'awaiting_evidence') then -- MUTATION",
      ),
  },
  {
    id: "C5 claim time taken from tasks.updated_at instead of the database clock",
    // Two edits, applied together: the insert column list has to admit `claimed_at` before a
    // value can be supplied for it, so half this mutation would be a syntax error rather than a
    // behaviour change — and a migration that will not apply proves nothing about the tests.
    apply: () => {
      sub(
        "    bound_state, bound_action_id, bound_evidence_digest, link_kind, note, idempotency_key\n  ) values (",
        "    bound_state, bound_action_id, bound_evidence_digest, link_kind, note, idempotency_key,\n    claimed_at\n  ) values (",
      );
      sub(
        "    nullif(btrim(coalesce(p_idempotency_key, '')), '')\n  )",
        "    nullif(btrim(coalesce(p_idempotency_key, '')), ''),\n" +
          "    (select t.updated_at from public.tasks t where t.id = p_task_id) -- MUTATION\n  )",
      );
    },
  },
  {
    id: "C6 the claim also marks the item verified",
    apply: () =>
      sub(
        "  insert into public.audit_events (",
        `  perform public.r1_draft_transition_item(
    p_item_id, 'verifying', 'verified', v_actor, 'user', 'MUTATION', '[]'::jsonb);

  insert into public.audit_events (`,
      ),
  },
  {
    id: "C7 the capability check is dropped (bare membership is enough)",
    apply: () =>
      sub(
        "  if not public.has_capability(v_company, 'operations.task.work') then",
        "  if false then -- MUTATION",
      ),
  },
  {
    id: "C8 a conflicting retry returns the first claim instead of refusing",
    apply: () =>
      sub(
        "      if v_existing.task_id = p_task_id and v_existing.claimant_user_id = v_actor then",
        "      if true then -- MUTATION",
      ),
  },
  {
    id: "C9 the evidence-generation binding is dropped",
    apply: () =>
      sub(
        "  if v_digest is distinct from p_expected_evidence_digest then",
        "  if false then -- MUTATION",
      ),
  },
  {
    id: "C10 the item is not locked (simultaneous claims are not serialised)",
    apply: () =>
      sub(
        "   where id = p_item_id\n   for update;",
        "   where id = p_item_id; -- MUTATION",
      ),
  },
  {
    id: "C11 the item-task link check is dropped (any task of the company will do)",
    apply: () => sub("  if v_link is null then", "  if false then -- MUTATION"),
  },
];

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
      env: { ...process.env, R1_SEC_ONLY: "tests/integration/r2-completion-claim.test.ts" },
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
    // A mutation that stops the MIGRATION applying never reaches a test, and calling that
    // "caught" would credit the suite with a detection it never made.
    verdict = "INCONCLUSIVE";
    detail = "no parsed Tests line — the campaign did not run the suite";
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
