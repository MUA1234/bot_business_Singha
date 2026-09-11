/**
 * The global execution boundary, after it stopped being a compile-time constant.
 *
 * ── What changed, and what must not have ─────────────────────────────────────────────────────
 *
 * `EXECUTION_GLOBALLY_ENABLED` was `false as const`. R2E-F-004 recorded why: an environment
 * variable makes the difference between a system that cannot act and one that can into a value
 * nobody reviews in a diff. That reasoning was right, and it is why the replacement is written the
 * way it is.
 *
 * It changed for one reason. Staging cannot verify the loop's single authorised effect without
 * producing it once, and a constant cannot be true in staging and false in production. Keeping the
 * constant would have meant shipping a Release 1 whose one automated effect had never been seen to
 * work anywhere.
 *
 * A variable is weaker than a constant. This suite is what the strength was traded for: the
 * properties the constant gave for free are now asserted, one test each, so that losing one is a
 * failing test rather than a quiet regression.
 *
 * ── The mutation tests ───────────────────────────────────────────────────────────────────────
 *
 * The last block does not assert that the code is correct. It asserts that specific WRONG versions
 * of it would be caught — the missing flag becoming enabled, a browser-controlled flag, a prefix
 * action match, and so on. A test suite that cannot fail on a plausible mutation is decoration,
 * and the only way to know is to write the mutation down and check.
 *
 * No database, no network, no model.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXECUTION_ENABLED_VAR,
  EXECUTION_ENABLED_VALUE,
  LOCAL_EXECUTION_TOKEN,
  browserReachableExecutionFlags,
  checkExecutionBoundaries,
  executionBoundaryDiagnostics,
  executionGloballyEnabled,
} from "@/kernel/execution/boundary";
import { allPolicies } from "@/kernel/execution/policy";
import { asCompanyId } from "@/kernel/ask-ai/identity";

const env = (o: Record<string, string | undefined> = {}) => o as NodeJS.ProcessEnv;
const CO = asCompanyId("11111111-1111-4111-8111-111111111111");

/**
 * Source with the COMMENTS REMOVED.
 *
 * Three assertions in this suite first ran against the raw text and failed on their own
 * explanations: a docstring saying "never a `NEXT_PUBLIC_` variable" matched a test asserting
 * that no `NEXT_PUBLIC_` variable is named. That is not a near miss, it is the wrong subject —
 * these tests are about what the code does, and prose is not code. Everything below that reads
 * source reads it stripped.
 */
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const stripSql = (s: string) => s.replace(/^\s*--.*$/gm, "");

const BOUNDARY_SRC = stripTs(readFileSync("src/kernel/execution/boundary.ts", "utf8"));
const TRANSPORT_SQL = stripSql(
  readFileSync("src/db/draft-migrations-r1/R1_DRAFT_029_execution_transport.up.sql", "utf8"),
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the flag is server-only, explicit, and false by default", () => {
  it("is false when the variable is missing", () => {
    expect(executionGloballyEnabled(env())).toBe(false);
  });

  it("is false when the variable is present but empty", () => {
    expect(executionGloballyEnabled(env({ [EXECUTION_ENABLED_VAR]: "" }))).toBe(false);
  });

  it("is false for every value that is not exactly the one accepted value", () => {
    // Each of these is something a person would plausibly type meaning "yes". None of them works,
    // because a boundary that accepts what somebody meant is a boundary that can be opened by a
    // typo in a deployment console.
    for (const v of ["true", "TRUE", "1", "yes", "y", "on ", " on", "On", "ON", "enabled", "0", "false"]) {
      expect(executionGloballyEnabled(env({ [EXECUTION_ENABLED_VAR]: v })), `value ${JSON.stringify(v)}`)
        .toBe(false);
    }
  });

  it("is true for exactly one value", () => {
    expect(executionGloballyEnabled(env({ [EXECUTION_ENABLED_VAR]: EXECUTION_ENABLED_VALUE }))).toBe(true);
    expect(EXECUTION_ENABLED_VALUE).toBe("on");
  });

  it("is OFF in this process, which is the deployed default", () => {
    expect(executionGloballyEnabled()).toBe(false);
  });

  it("reads ONE variable, and nothing else in the environment can stand in for it", () => {
    // A near-miss name, a namespaced variant, and the value in somebody else's variable.
    const decoys = {
      EXECUTION_ENABLE: "on",
      EXECUTIONS_ENABLED: "on",
      EXECUTION_ENABLED_OVERRIDE: "on",
      NEXT_PUBLIC_EXECUTION_ENABLED: "on",
      MANAGEMENT_KERNEL: "on",
      NODE_ENV: "production",
    };
    expect(executionGloballyEnabled(env(decoys))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("no browser-reachable variable participates", () => {
  it("finds none in this process", () => {
    expect(browserReachableExecutionFlags()).toEqual([]);
  });

  it("REPORTS one if it is ever introduced — the test is the alarm, not the absence", () => {
    // The danger is not today's code; it is the future commit that adds
    // `NEXT_PUBLIC_EXECUTION_ENABLED` "for the admin screen". If that happens, this reports it.
    expect(browserReachableExecutionFlags(env({ NEXT_PUBLIC_EXECUTION_ENABLED: "on" })))
      .toEqual(["NEXT_PUBLIC_EXECUTION_ENABLED"]);
    expect(browserReachableExecutionFlags(env({ NEXT_PUBLIC_ALLOW_EXECUTION: "1" })))
      .toEqual(["NEXT_PUBLIC_ALLOW_EXECUTION"]);
  });

  it("and such a variable, if present, still does not enable anything", () => {
    expect(executionGloballyEnabled(env({ NEXT_PUBLIC_EXECUTION_ENABLED: "on" }))).toBe(false);
  });

  it("the source names no NEXT_PUBLIC_ execution variable at all", () => {
    // Next.js inlines `NEXT_PUBLIC_*` into the client bundle, where the browser can read it and a
    // compromised build can set it. The check is on the source rather than the runtime because
    // the defect would be introduced in a diff, and that is where it should be caught.
    expect(BOUNDARY_SRC).not.toMatch(/NEXT_PUBLIC_[A-Z_]*EXECUT/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("it is recorded at startup, without printing a secret", () => {
  it("reports the variable NAME and a boolean — never a value", () => {
    const d = executionBoundaryDiagnostics(env({ [EXECUTION_ENABLED_VAR]: "on" }));
    expect(d).toEqual({
      variable: EXECUTION_ENABLED_VAR,
      enabled: true,
      browserReachableFlags: [],
    });
    // Every field, serialised, contains no value from the environment.
    expect(JSON.stringify(d)).not.toContain("on");
  });

  it("carries nothing from the environment except names it was asked about", () => {
    const d = executionBoundaryDiagnostics(env({
      [EXECUTION_ENABLED_VAR]: "on",
      SUPABASE_SERVICE_ROLE_KEY: "sbp_do_not_print_me",
      DATABASE_URL: "postgresql://u:p@host/db",
      OPENAI_API_KEY: "sk-do-not-print-me",
    }));
    const text = JSON.stringify(d);
    for (const secret of ["sbp_do_not_print_me", "sk-do-not-print-me", "postgresql://", "host/db"]) {
      expect(text, `diagnostics leaked ${secret}`).not.toContain(secret);
    }
  });

  it("is wired into startup, not merely available to be called", () => {
    // The requirement is that a system which CAN act says so at startup. A function nobody calls
    // satisfies the letter of that and none of the point.
    const instrumentation = readFileSync("src/instrumentation.ts", "utf8");
    expect(instrumentation).toContain("executionBoundaryDiagnostics");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("it grants exactly one thing", () => {
  it("cannot widen the action allowlist", () => {
    // The allowlist is the policy table plus a single-member handler union. Neither reads the
    // environment, so no value of any variable changes what may be executed.
    const under = (v: string | undefined) => {
      const saved = process.env[EXECUTION_ENABLED_VAR];
      if (v === undefined) delete process.env[EXECUTION_ENABLED_VAR];
      else process.env[EXECUTION_ENABLED_VAR] = v;
      try {
        return allPolicies()
          .filter(([, p]) => p.classification === "locally_executable")
          .map(([id]) => id)
          .sort();
      } finally {
        if (saved === undefined) delete process.env[EXECUTION_ENABLED_VAR];
        else process.env[EXECUTION_ENABLED_VAR] = saved;
      }
    };
    expect(under(undefined)).toEqual(["ops.task.create_internal"]);
    expect(under("on")).toEqual(["ops.task.create_internal"]);
    expect(under("on")).toEqual(under(undefined));
  });

  it("does not enable a model job — that is a separate control", () => {
    // Independent switches: stopping spend and stopping execution must be two decisions, so that
    // an operator can do either without doing the other.
    expect(EXECUTION_ENABLED_VAR).not.toBe("MANAGEMENT_KERNEL");
    expect(BOUNDARY_SRC).not.toMatch(/MODEL_JOBS|MANAGEMENT_KERNEL/);
  });

  it("does not bypass the per-company boundary", async () => {
    // A company may be observed without being acted upon. The global switch says nothing about
    // which companies; it says only that the system is permitted to act at all.
    process.env[EXECUTION_ENABLED_VAR] = "on";
    try {
      const decision = await checkExecutionBoundaries({
        companyId: CO,
        companyExecutionEnabled: async () => false,
      });
      expect(decision.ok).toBe(false);
      expect(decision.ok === false && decision.reason).toBe("company_not_enabled");
    } finally {
      delete process.env[EXECUTION_ENABLED_VAR];
    }
  });

  it("does not bypass the SERVER-side boundary row", () => {
    // The other half of the switch lives in the database, defaults to false, and is read inside
    // the transaction that would produce the effect. Both must permit execution.
    expect(TRANSPORT_SQL).toMatch(/create table if not exists public\.r1_exec_global_boundary/);
    expect(TRANSPORT_SQL).toMatch(/enabled\s+boolean not null default false/);
    expect(TRANSPORT_SQL).toMatch(
      /if not coalesce\(\(select enabled from public\.r1_exec_global_boundary where id = true\), false\) then/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the boundaries are checked in order, and a shut one reveals nothing", () => {
  it("asks nothing about the company when the global boundary is shut", async () => {
    let asked = false;
    const decision = await checkExecutionBoundaries({
      companyId: CO,
      companyExecutionEnabled: async () => { asked = true; return true; },
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toBe("global_boundary_disabled");
    // Not even whether that company exists.
    expect(asked, "the company enablement was read despite a shut global boundary").toBe(false);
  });

  it("treats an unreadable company boundary as a closed one", async () => {
    process.env[EXECUTION_ENABLED_VAR] = "on";
    try {
      const decision = await checkExecutionBoundaries({
        companyId: CO,
        companyExecutionEnabled: async () => { throw new Error("connection refused"); },
      });
      expect(decision.ok).toBe(false);
      expect(decision.ok === false && decision.reason).toBe("company_not_enabled");
    } finally {
      delete process.env[EXECUTION_ENABLED_VAR];
    }
  });

  it("the local token opens the global boundary and NOTHING else", async () => {
    const shut = await checkExecutionBoundaries({
      companyId: CO,
      localToken: LOCAL_EXECUTION_TOKEN,
      companyExecutionEnabled: async () => false,
    });
    expect(shut.ok === false && shut.reason).toBe("company_not_enabled");

    const open = await checkExecutionBoundaries({
      companyId: CO,
      localToken: LOCAL_EXECUTION_TOKEN,
      companyExecutionEnabled: async () => true,
    });
    expect(open.ok).toBe(true);
  });

  it("the local token is not readable from the environment", () => {
    // No `.env`, no CI variable and no test-runner configuration can supply it: a caller that has
    // one is a caller that typed it into a test file.
    expect(BOUNDARY_SRC).toMatch(/LOCAL_EXECUTION_TOKEN = "[^"]+" as const/);
    const tokenLine = BOUNDARY_SRC.split("\n").find((l) => l.includes("LOCAL_EXECUTION_TOKEN ="));
    expect(tokenLine).not.toMatch(/process\.env/);
    expect(executionGloballyEnabled(env({ [EXECUTION_ENABLED_VAR]: LOCAL_EXECUTION_TOKEN }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The mutation checks. Each names a wrong version and shows the parsed evidence that catches it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("mutation checks — each of these WRONG versions is caught by parsed evidence", () => {
  /** Read the SQL as a mutated copy, and run a predicate that must reject it. */
  const mutateSql = (from: string | RegExp, to: string) => TRANSPORT_SQL.replace(from, to);

  it("MUTATION 1 — a missing flag becomes ENABLED", () => {
    // The wrong version: `env[VAR] !== "off"`, so absence means yes.
    const wrong = (e: NodeJS.ProcessEnv) => e[EXECUTION_ENABLED_VAR] !== "off";
    expect(wrong(env())).toBe(true);                     // the mutation's answer
    expect(executionGloballyEnabled(env())).toBe(false); // ours, and the test above fails on the mutation
    expect(wrong(env())).not.toBe(executionGloballyEnabled(env()));
  });

  it("MUTATION 2 — the flag becomes browser-controlled", () => {
    const wrong = (e: NodeJS.ProcessEnv) =>
      e[EXECUTION_ENABLED_VAR] === "on" || e.NEXT_PUBLIC_EXECUTION_ENABLED === "on";
    const browserSet = env({ NEXT_PUBLIC_EXECUTION_ENABLED: "on" });
    expect(wrong(browserSet)).toBe(true);
    expect(executionGloballyEnabled(browserSet)).toBe(false);
    // And the detector reports the variable's existence regardless of what reads it.
    expect(browserReachableExecutionFlags(browserSet)).toHaveLength(1);
  });

  it("MUTATION 3 — the action match becomes a prefix or fuzzy match", () => {
    // The SQL matches the action with `is distinct from`, which is exact. A prefix match would
    // let `ops.task.create_internal_and_send` through the whole autonomy ceiling.
    expect(TRANSPORT_SQL).toMatch(/p_action is distinct from 'ops\.task\.create_internal'/);
    const mutated = mutateSql(
      /p_action is distinct from 'ops\.task\.create_internal'/,
      "p_action not like 'ops.task.create_internal%'",
    );
    expect(mutated).not.toBe(TRANSPORT_SQL);
    expect(mutated).not.toMatch(/p_action is distinct from 'ops\.task\.create_internal'/);
    // The catalogue side: exactly one executable action, matched by identity, not by shape.
    expect(allPolicies()
      .filter(([, p]) => p.classification === "locally_executable")
      .map(([id]) => id)).toEqual(["ops.task.create_internal"]);
  });

  it("MUTATION 4 — the per-company switch is removed", () => {
    expect(TRANSPORT_SQL).toMatch(/v_enabled := public\.r1_exec_company_enabled\(p_company\)/);
    expect(TRANSPORT_SQL).toMatch(/if not v_enabled then/);
    const mutated = mutateSql(/if not v_enabled then/, "if false then");
    expect(mutated).not.toBe(TRANSPORT_SQL);
    // And an ABSENT enablement row means disabled, never "unknown, assume yes": the lookup ends
    // `return coalesce(v_on, false)`, so a company with no row is a company that may not be acted
    // upon.
    expect(TRANSPORT_SQL).toMatch(
      /from public\.management_execution_enablement\s*\n\s*where company_id = p_company;\s*\n\s*return coalesce\(v_on, false\);/,
    );
  });

  it("MUTATION 5 — the global switch is removed", () => {
    const guard = /if not coalesce\(\(select enabled from public\.r1_exec_global_boundary where id = true\), false\) then/;
    expect(TRANSPORT_SQL).toMatch(guard);
    const mutated = mutateSql(guard, "if false then");
    expect(mutated).not.toBe(TRANSPORT_SQL);
    expect(mutated).not.toMatch(guard);
    // The TypeScript half, independently.
    expect(BOUNDARY_SRC).toMatch(/if \(!globallyOn && !localTest\)/);
  });

  it("MUTATION 6 — evidence freshness is removed", () => {
    // The condition-evidence digest, compared BOTH against the live evidence and against what the
    // plan was recorded with. Removing either half makes a stale authorisation executable.
    expect(TRANSPORT_SQL).toMatch(
      /public\.r1_exec_evidence_digest\(p_company, p_item\) is distinct from p_condition_digest/,
    );
    expect(TRANSPORT_SQL).toMatch(
      /v_plan\.condition_evidence_digest is distinct from p_condition_digest/,
    );
    const mutated = mutateSql(
      /public\.r1_exec_evidence_digest\(p_company, p_item\) is distinct from p_condition_digest\s*\n\s*or /,
      "",
    );
    expect(mutated).not.toBe(TRANSPORT_SQL);
    // And the digest is over CONTENT, not a count: three invoices replaced by three others is a
    // different digest and the same count.
    expect(TRANSPORT_SQL).toMatch(/string_agg\(source_table \|\| ':' \|\| source_id/);
  });

  it("MUTATION 7 — the ledger and the effect stop being one transaction", () => {
    // The whole reason this function exists. The task creation and the terminal ledger row are
    // consecutive statements in one plpgsql body, with no commit between them, and there is no
    // second entry point that could produce the effect without the row.
    const body = TRANSPORT_SQL.slice(
      TRANSPORT_SQL.indexOf("create or replace function public.r1_exec_create_internal_task"),
    );
    const effectAt = body.indexOf("r1_draft_create_internal_task(");
    const ledgerAt = body.indexOf("insert into public.management_execution_attempts");
    expect(effectAt).toBeGreaterThan(0);
    expect(ledgerAt).toBeGreaterThan(effectAt);
    // Nothing between them may end the transaction.
    const between = body.slice(effectAt, ledgerAt);
    expect(between).not.toMatch(/\bcommit\b|\brollback\b|\bbegin\b/i);
    // And no exception handler swallows a failed ledger write, which would leave a task with
    // nothing saying it exists.
    expect(body.slice(ledgerAt)).not.toMatch(/\bexception\s+when\b/i);
  });
});
