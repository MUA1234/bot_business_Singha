/**
 * Mutation harness for authority-scoped visibility and the two higher authority levels.
 *
 * Same contract as the decision-boundary harness: each mutation is applied to the draft SQL, the
 * live campaign runs against a FRESH disposable database, and the parsed `Tests N failed | M passed`
 * line decides the verdict.
 *
 * No parsed line means INCONCLUSIVE, never "survived" — a harness that did not run the tests has
 * shown nothing about whether a mutation is detected.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

/** A full ANSI colour escape: ESC, '[', parameters, 'm'. Built without a literal control byte. */
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g");

const SCOPE = "src/db/draft-migrations-r1/R1_DRAFT_023_authority_and_scope.up.sql";
const RPC = "src/db/draft-migrations-r1/R1_DRAFT_022_decision_rpc.up.sql";
const BACKUPS = { [SCOPE]: `${SCOPE}.bak`, [RPC]: `${RPC}.bak` };

for (const [f, b] of Object.entries(BACKUPS)) copyFileSync(f, b);
const restore = () => {
  for (const [f, b] of Object.entries(BACKUPS)) copyFileSync(b, f);
};

function sub(file, from, to) {
  const s = readFileSync(file, "utf8");
  if (!s.includes(from)) throw new Error(`anchor missing in ${file}: ${from.slice(0, 70)}`);
  writeFileSync(file, s.replace(from, to), "utf8");
}

const MUTATIONS = [
  {
    id: "S1 sensitive-domain gate removed (legal/workforce fall through to the general rule)",
    apply: () =>
      sub(
        SCOPE,
        "  if p_department in ('legal', 'workforce') then",
        "  if false and p_department in ('legal', 'workforce') then",
      ),
  },
  {
    id: "S2 own-work check ignores WHOSE membership it is",
    apply: () =>
      sub(
        SCOPE,
        "     where m.id = p_owner and m.user_id = v_actor\n       and m.company_id = p_company and m.status = 'active'",
        "     where m.id = p_owner\n       and m.company_id = p_company and m.status = 'active'",
      ),
  },
  {
    id: "S3 active-membership check dropped",
    apply: () =>
      sub(
        SCOPE,
        "     where m.user_id = v_actor and m.company_id = p_company and m.status = 'active'\n  ) then\n    return false;",
        "     where m.user_id = v_actor and m.company_id = p_company\n  ) then\n    return false;",
      ),
  },
  {
    id: "S4 evidence policy left company-wide while the item is scoped",
    apply: () =>
      sub(
        SCOPE,
        `create policy management_item_evidence_sel on public.management_item_evidence
             for select to authenticated using (public.r1_draft_may_see_item(item_id))`,
        `create policy management_item_evidence_sel on public.management_item_evidence
             for select to authenticated using (public.has_company_access(company_id))`,
      ),
  },
  {
    id: "S5 owner approval satisfied by ordinary `approve`",
    apply: () =>
      sub(
        RPC,
        "    if not public.has_capability(v_company, 'management.decision.approve_owner') then",
        "    if not public.has_capability(v_company, 'approve') then",
      ),
  },
  {
    id: "S6 specialist gate ignores the item's domain (uses a fixed capability)",
    apply: () =>
      sub(
        RPC,
        "    v_specialist := public.r1_draft_specialist_capability(v_item.department);",
        "    v_specialist := 'approve';",
      ),
  },
  {
    id: "S7 unmapped domain falls back instead of refusing",
    apply: () =>
      sub(
        SCOPE,
        "    when 'finance'     then null",
        "    when 'finance'     then 'finance.reconcile'",
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
      env: {
        ...process.env,
        R1_SEC_ONLY:
          "tests/integration/r2-authority-and-scope.test.ts,tests/integration/r2-decision-boundary.test.ts",
      },
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  // Strip the WHOLE escape sequence, ESC byte included.
  //
  // The first version stripped only `[31m` and left the ESC before it. `Tests\s+(\d+)` then could
  // not match, because `\s` does not match ESC — so the "failed" branch NEVER fired and every
  // mutation was reported SURVIVED, including ones that demonstrably fail their test. The
  // permissive "passed" pattern still matched, because `[^\n]*?` crosses ESC happily, which is
  // exactly what made the wrong answer look like a real one.
  const plain = out.replace(ANSI, "");
  const summary = plain.split("\n").find((l) => /\bTests\b/.test(l) && /passed|failed/.test(l));
  const failed = summary ? summary.match(/(\d+)\s+failed/) : null;
  const passed = summary ? summary.match(/(\d+)\s+passed/) : null;

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
