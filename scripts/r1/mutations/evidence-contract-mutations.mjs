/**
 * Mutation harness for the separated evidence contracts (R2F-F-017).
 *
 * The suite passes. That is not evidence it would notice if the separation collapsed, so each
 * mutation below reintroduces one version of the original defect — or removes one of the freshness
 * checks that now exists — and the campaign is re-run against a real database.
 *
 * The mutations are the ones the owner named: swapping the two digests, skipping condition
 * freshness, skipping parameter freshness, accepting a stale candidate, using a caller-supplied
 * digest, and returning to the cross-set comparison.
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
takeMutationLock("evidence-contract-mutations.mjs");

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const NL = String.fromCharCode(10);

const EXECUTOR = "src/kernel/execution/executor.ts";
const SERVICE = "src/kernel/execution/service.ts";
const SQL = "src/db/migrations/0138_evidence_contracts.sql";
const FILES = [EXECUTOR, SERVICE, SQL];

for (const f of FILES) copyFileSync(f, `${f}.bak`);
const restore = () => { for (const f of FILES) copyFileSync(`${f}.bak`, f); };

function sub(file, from, to) {
  const s = readFileSync(file, "utf8");
  if (!s.includes(from)) throw new Error(`anchor missing in ${file}: ${from.slice(0, 70)}`);
  writeFileSync(file, s.replace(from, () => to), "utf8");
}

const MUTATIONS = [
  {
    id: "E1 the two digests are SWAPPED at the point of comparison",
    apply: () =>
      sub(
        SERVICE,
        "        plan: await loadPlan(sql, req.companyId, req.itemId),",
        `        plan: await (async () => {
          const p = await loadPlan(sql, req.companyId, req.itemId);
          if (!p) return null;
          const { rows } = await sql(
            \`select eligibility_evidence_digest from management_item_recommendations
              where company_id = $1 and item_id = $2 and condition_evidence_digest is not null
              order by created_at desc limit 1\`,
            [req.companyId, req.itemId]);
          return { ...p, conditionEvidenceDigest: String(rows[0]?.eligibility_evidence_digest ?? "") };
        })(), // MUTATION`,
      ),
  },
  {
    id: "E2 condition freshness is not checked at all",
    apply: () =>
      sub(
        EXECUTOR,
        "  if (decidedAgainst !== item.evidenceGeneration) {",
        "  if (false) { // MUTATION",
      ),
  },
  {
    id: "E3 parameter freshness is not checked",
    apply: () =>
      sub(EXECUTOR, "    if (plan.parameterDigest !== params.hash) {", "    if (false) { // MUTATION"),
  },
  {
    id: "E4 policy-version freshness is not checked",
    apply: () =>
      sub(
        EXECUTOR,
        "    if (plan.policyVersion !== EXECUTION_POLICY_VERSION) {",
        "    if (false) { // MUTATION",
      ),
  },
  {
    id: "E5 an item with NO recorded plan executes anyway",
    apply: () =>
      sub(
        EXECUTOR,
        "  if (!approval && !plan) {",
        "  if (false) { // MUTATION",
      ),
  },
  {
    id: "E6 the parameter digest is TRUSTED from its column, not re-derived from the plan",
    apply: () =>
      sub(
        SERVICE,
        `  const parameterDigest =
    derived !== null && stored !== null && derived !== stored ? "plan-inconsistent" : (derived ?? "no-parameters");`,
        `  const parameterDigest = stored ?? derived ?? "no-parameters"; // MUTATION`,
      ),
  },
  {
    id: "E7 the condition digest is taken from the CALLER instead of the evidence",
    apply: () =>
      sub(
        SQL,
        "  v_condition := public.r1_draft_condition_digest_of(p_evidence);",
        `  v_condition := coalesce(p_parameter_digest, public.r1_draft_condition_digest_of(p_evidence)); -- MUTATION`,
      ),
  },
  {
    id: "E8 the create RPC does not verify its digest against the stored evidence",
    apply: () =>
      sub(
        SQL,
        "    if v_stored is distinct from v_condition then",
        "    if false then -- MUTATION",
      ),
  },
  {
    id: "E9 the eligibility digest is set to the condition digest (the two sets merged)",
    apply: () =>
      sub(
        SQL,
        `          'eligibility_evidence_digest',
            public.r1_draft_eligibility_digest(coalesce(v_rec->'evidence_refs', '[]'::jsonb)),`,
        `          'eligibility_evidence_digest', v_condition, -- MUTATION`,
      ),
  },
  {
    id: "E10 the cycle records no plan at all",
    apply: () =>
      sub(
        SQL,
        "          'planned_parameters', p_planned_parameters,",
        "          'planned_parameters', null::jsonb, -- MUTATION",
      ),
  },
];

const SUITES = [
  "tests/integration/r2-evidence-contracts.test.ts",
  "tests/integration/r2e-execution-ledger.test.ts",
].join(",");

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
      env: { ...process.env, R1_SEC_ONLY: SUITES },
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
    // A mutation that stops the MIGRATION applying never reaches a test, and calling that "caught"
    // would credit the suite with a detection it never made.
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
