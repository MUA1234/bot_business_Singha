/**
 * Mutation harness for the management decision boundary.
 *
 * Each mutation is applied to the draft SQL, the live campaign runs against a FRESH disposable
 * database, and the parsed `Tests N failed | M passed` line decides the verdict.
 *
 * A run that produces no parsed line is INCONCLUSIVE, never "survived". The distinction matters:
 * a harness that failed to execute the tests has not shown that a mutation goes undetected, and
 * an earlier campaign in this repository did report exactly that as a survival.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

/** A full ANSI colour escape: ESC, '[', parameters, 'm'. Built without a literal control byte. */
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g");

const SQL = "src/db/draft-migrations-r1/R1_DRAFT_022_decision_rpc.up.sql";
const DEC = "src/db/draft-migrations-r1/R1_DRAFT_004_decisions.up.sql";
const BACKUPS = { [SQL]: `${SQL}.bak`, [DEC]: `${DEC}.bak` };

for (const [f, b] of Object.entries(BACKUPS)) copyFileSync(f, b);
const restore = () => {
  for (const [f, b] of Object.entries(BACKUPS)) copyFileSync(b, f);
};

/** Apply `from` to `to` in `file`, failing loudly when the anchor is absent. */
function sub(file, from, to) {
  const s = readFileSync(file, "utf8");
  if (!s.includes(from)) throw new Error(`anchor missing in ${file}: ${from.slice(0, 70)}`);
  writeFileSync(file, s.replace(from, to), "utf8");
}

const MUTATIONS = [
  {
    id: "M1 company binding removed from the membership check",
    apply: () =>
      sub(
        SQL,
        "     where m.user_id = v_actor and m.company_id = v_company and m.status = 'active'",
        "     where m.user_id = v_actor and m.status = 'active'",
      ),
  },
  {
    id: "M2 capability check removed (session role trusted alone)",
    apply: () =>
      sub(
        SQL,
        "  if not public.has_capability(v_company, v_capability) then",
        "  if false and not public.has_capability(v_company, v_capability) then",
      ),
  },
  {
    id: "M3 evidence-digest comparison skipped",
    apply: () =>
      sub(
        SQL,
        "  if v_digest is distinct from p_expected_evidence_digest then",
        "  if false and v_digest is distinct from p_expected_evidence_digest then",
      ),
  },
  {
    id: "M4 item lock removed (two concurrent winners possible)",
    apply: () => sub(SQL, "   where id = p_item_id\n   for update;", "   where id = p_item_id;"),
  },
  {
    id: "M5 decision history made mutable",
    apply: () =>
      sub(
        DEC,
        "  before update or delete on management_item_decisions",
        "  before insert on management_item_decisions",
      ),
  },
  {
    id: "M6 approval invokes execution directly",
    apply: () =>
      sub(
        SQL,
        "  return jsonb_build_object('ok', true, 'result', 'recorded',",
        [
          "  if p_decision = 'approve' then",
          "    insert into public.tasks (company_id, title, status, requires_evidence)",
          "    values (v_company, 'MUTATION executed on approval', 'captured', false);",
          "  end if;",
          "",
          "  return jsonb_build_object('ok', true, 'result', 'recorded',",
        ].join("\n"),
      ),
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
      env: { ...process.env, R1_SEC_ONLY: "tests/integration/r2-decision-boundary.test.ts" },
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  // Strip the WHOLE escape sequence, ESC byte included. Stripping only `[31m` leaves the ESC,
  // and `Testss+(d+)` cannot cross it — so the "failed" branch never fires and every mutation
  // reads as SURVIVED. The scope harness was written that way and produced seven false verdicts
  // before the defect was found; this one is corrected to match.
  const plain = out.replace(ANSI, "");
  const summary = plain.split(String.fromCharCode(10)).find((l) => /Tests/.test(l) && /passed|failed/.test(l));
  const failed = summary ? summary.match(/(d+)s+failed/) : null;
  const passed = summary ? summary.match(/(d+)s+passed/) : null;

  let verdict;
  let detail;
  if (!summary || (!failed && !passed)) {
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
console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.id} - ${r.detail}`);
const bad = results.filter((r) => r.verdict !== "CAUGHT");
console.log(bad.length ? `\n${bad.length} mutation(s) NOT caught` : "\nall mutations caught");
