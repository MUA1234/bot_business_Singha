import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { DEFAULT_JOBS } from "@/lib/scheduler";
import {
  EXECUTION_ENABLED_VAR,
  browserReachableExecutionFlags,
  executionGloballyEnabled,
} from "@/kernel/execution/boundary";
import { allPolicies, handlerFor } from "@/kernel/execution/policy";
import { EXECUTION_RPCS } from "@/kernel/execution/postgrest-transport";
import { codeOnlyTs } from "../helpers/source-text";

/**
 * Release 1 composition — is the loop wired through the DEPLOYED graph, or only through tests?
 *
 * "Any implementation that exists but is not called through the deployed dependency graph is
 * incomplete." The kernel has repeatedly had the opposite problem: a capability that existed,
 * was tested directly, and was reachable by nothing. R2F-F-014 was exactly that — the lifecycle
 * hops had no runtime writer, and the tests that "proved" them called the database function
 * themselves. R2E-F-00x was the same shape for verification: the deployed factory did not supply
 * a dependency, so the system verified nothing and reported zeroes, which is indistinguishable
 * from having nothing to verify.
 *
 * So these assertions are about WIRING, deliberately. They ask what the production factory
 * actually returns and what the production scheduler actually drives — not whether a function
 * behaves correctly when a test calls it, which the other suites cover.
 *
 * They need no database: `makeCycleDeps` is a factory, and inspecting the graph it builds is the
 * point. It is in `tests/integration/` because it imports the server-side Supabase client.
 */

describe("the deployed cycle factory supplies every mandatory dependency", () => {
  // A stub with the shape `makeCycleDeps` needs, so this never opens a connection.
  const fakeDb = { from: () => ({ select: () => ({}) }), rpc: () => ({}) } as never;
  const deps = makeCycleDeps(fakeDb) as unknown as Record<string, unknown>;

  it("supplies the readers and writers the cycle cannot run without", () => {
    for (const key of [
      "loadFor", "loadPage", "readCursor", "writeCursor", "now",
      "persist", "findByIdentity", "isCompanyEnabled", "tryLock", "releaseLock",
      "recordRun", "authorityFor",
    ]) {
      expect(typeof deps[key], `makeCycleDeps must supply ${key}`).toBe("function");
    }
  });

  it("supplies the reconciliation and rescan reader — the sweep is inert without it", () => {
    // `loadReconcile` absent means `needsReconcileSweep` sources never reconcile, and the cycle
    // reports a calm that was never established.
    expect(typeof deps.loadReconcile).toBe("function");
  });

  it("supplies the lifecycle sweep, which is what advances an item at all", () => {
    // R2F-F-014: before this was wired, an item created by the cycle sat in `observed` for ever,
    // and the tests that "proved" the hops called the database function themselves.
    expect(typeof deps.lifecycleSweep).toBe("function");
  });

  it("supplies the verification sweep rather than leaving it undefined", () => {
    // R2E: a factory that omitted this made the system verify nothing and report zeroes, which
    // reads exactly like a company with nothing to verify.
    expect(typeof deps.verificationSweep).toBe("function");
  });

  it("does NOT supply a local execution token — no server path may have one", () => {
    // The token is the deterministic-local-test escape hatch. A production factory handing one
    // out would make every other execution boundary decorative.
    expect(deps.localToken).toBeUndefined();
  });

  it("supplies NO SQL transport — and reaches the executor over PostgREST regardless", () => {
    // This test used to assert that the absence WAS the gap: R2F-F-019, the executor reachable
    // only through raw SQL that the request path cannot speak, so the orchestrator recorded an
    // "execution transport unavailable" hold and marked every cycle partial.
    //
    // The absence is still real and still correct — no server path holds a PostgreSQL connection.
    // What changed is that it is no longer a gap: the service builds its loaders, its ledger and
    // its one atomic execute from named RPCs over the same PostgREST client this factory already
    // has. `r2f-postgrest-execution.test.ts` drives the whole loop through this very factory,
    // with the fourth argument omitted exactly as it is here, and watches the effect appear.
    expect(deps.executionSql).toBeUndefined();

    // The transport is registered, not implied. Every RPC it may call is named here, so adding a
    // sixth one is a visible change in a diff rather than a new database surface nobody reviewed.
    expect([...EXECUTION_RPCS]).toEqual([
      "r1_exec_company_enabled",
      "r1_exec_load_item",
      "r1_exec_load_approval",
      "r1_exec_approver_capabilities",
      "r1_exec_create_internal_task",
      "r1_exec_record_refusal",
    ]);
    // And none of them is a generic SQL executor, which was the fix NOT taken.
    for (const rpc of EXECUTION_RPCS) {
      expect(rpc).toMatch(/^r1_exec_[a-z_]+$/);
      expect(rpc).not.toMatch(/sql|query|exec_raw|statement/);
    }
  });
});

describe("the scheduler reaches the management cycle", () => {
  it("schedules the management-cycle job", () => {
    // Without this the loop advances only when a person presses a button on
    // /api/management/cycle, which resolves its caller from a session a scheduler cannot have.
    expect(DEFAULT_JOBS.map((j) => j.job)).toContain("management-cycle");
  });

  it("the scheduled route actually calls runManagementCycle through the shared factory", () => {
    // Source-level, and honest about being so: this proves the route is not a second
    // implementation of the cycle, which is the failure the kernel exists to prevent.
    const route = readFileSync("src/app/api/cron/management-cycle/route.ts", "utf8");
    expect(route).toContain("runManagementCycle");
    expect(route).toContain("makeCycleDeps");
    // Authorised by the shared cron secret, compared in constant time.
    expect(route).toContain("CRON_SECRET");
    expect(route).toContain("timingSafeEqual");
  });

  it("the scheduled cycle runs with NO actor — it may not borrow a human identity", () => {
    const route = readFileSync("src/app/api/cron/management-cycle/route.ts", "utf8");
    expect(route).toMatch(/actorId:\s*null/);
    expect(route).toMatch(/trigger:\s*"scheduled"/);
  });

  it("reports `disabled` honestly rather than a silent success", () => {
    // A monitor that cannot tell "off" from "ran and found nothing" is how a stopped loop goes
    // unnoticed for a month.
    const route = readFileSync("src/app/api/cron/management-cycle/route.ts", "utf8");
    expect(route).toContain("kernelGloballyEnabled");
    expect(route).toMatch(/status:\s*"disabled"/);
  });
});

describe("the autonomy ceiling is exactly one action, and it is welded shut besides", () => {
  it("execution is globally disabled unless one server variable says exactly \"on\"", () => {
    // This was asserted as a COMPILE-TIME constant, and the assertion was right for what the
    // code then was. The constant became a variable so that staging could observe the loop's
    // one authorised effect at least once — a constant cannot be true in staging and false in
    // production. What that assertion was really protecting is kept and asserted here instead:
    // the default is off, only one exact value turns it on, and no browser-reachable variable
    // participates at all.
    const env = (v?: string) =>
      (v === undefined ? {} : { [EXECUTION_ENABLED_VAR]: v }) as NodeJS.ProcessEnv;
    expect(executionGloballyEnabled(env())).toBe(false);
    expect(executionGloballyEnabled(env(""))).toBe(false);
    expect(executionGloballyEnabled(env("true"))).toBe(false);
    expect(executionGloballyEnabled(env("1"))).toBe(false);
    expect(executionGloballyEnabled(env("ON"))).toBe(false);
    expect(executionGloballyEnabled(env("on"))).toBe(true);

    // And it is off in THIS process, which is the deployed default.
    expect(executionGloballyEnabled()).toBe(false);
    expect(browserReachableExecutionFlags()).toEqual([]);

    // Never a NEXT_PUBLIC_ variable: Next.js inlines those into the client bundle.
    //
    // COMMENTS STRIPPED. The raw file matched on its own docstring — the sentence explaining that
    // the danger is "the future commit that adds `NEXT_PUBLIC_EXECUTION_ENABLED`". A test that
    // fails on the explanation of the rule is not testing the rule.
    const src = readFileSync("src/kernel/execution/boundary.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/NEXT_PUBLIC_[A-Z_]*EXECUT/);
    // The ONE place the prefix legitimately appears in code is the detector that reports such a
    // variable if one is ever introduced, and it builds the name from a pattern, not a literal.
    expect(src).toMatch(/\/\^NEXT_PUBLIC_\.\*EXECUT\/i\.test/);
  });

  it("exactly ONE action is executable; every other policy is draft_only", () => {
    // The ceiling is the POLICY table, not the catalogue. Several catalogue entries carry
    // `automaticSafe: true` — that is a statement about the action's nature, not a grant. What
    // decides whether a real effect can be produced is the classification here.
    const executable = allPolicies()
      .filter(([, p]) => p.classification === "locally_executable")
      .map(([id]) => id);
    expect(executable).toEqual(["ops.task.create_internal"]);
  });

  it("only that action resolves to a handler; everything else resolves to null", () => {
    for (const [id, policy] of allPolicies()) {
      const handler = handlerFor(id);
      if (id === "ops.task.create_internal") {
        expect(handler, "the one authorised action must have a handler").toBe("ops.task.create_internal.v1");
      } else {
        expect(handler, `${id} must have NO handler — a policy may not name one that does not run`).toBeNull();
      }
      // A non-null handler outside `locally_executable` would be a door with no lock on it.
      if (policy.classification !== "locally_executable") expect(policy.handler).toBeNull();
    }
  });

  it("the handler key type admits exactly one value, so a second effect cannot be added by accident", () => {
    // Type-level, asserted at source: widening this union is a deliberate, reviewable act.
    const contract = readFileSync("src/kernel/execution/contract.ts", "utf8");
    const decl = /export type ExecutionHandlerKey =\s*("[^"]+")(\s*\|\s*"[^"]+")*/.exec(contract);
    expect(decl, "ExecutionHandlerKey declaration not found").not.toBeNull();
    expect(decl![0]).toBe('export type ExecutionHandlerKey = "ops.task.create_internal.v1"');
  });

  it("that action creates an UNASSIGNED task, enforced by ABSENCE rather than by a null", () => {
    // Assignment is a human manager's act; an automatically-assigned task would hand work to a
    // person nobody chose. The command cannot express one: there is no `assignedTo` parameter
    // and no transport that accepts one, which is a stronger guarantee than passing null —
    // a null can be changed to a value in a one-line diff that reads as a fix.
    // CODE only. The file's own documentation says "there is no `assignedTo` parameter", so a
    // naive search matches the sentence promising the opposite of what it is looking for.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    const command = stripComments(readFileSync("src/modules/work/create-internal-task.ts", "utf8"));
    expect(command).not.toMatch(/\bassignedTo\b/);
    expect(command).not.toMatch(/\bassigned_to\b/);
    expect(command).not.toMatch(/\bp_assigned/);

    // And the handler does not smuggle one in.
    const service = readFileSync("src/kernel/execution/service.ts", "utf8");
    const handlerStart = service.indexOf('"ops.task.create_internal.v1"');
    expect(handlerStart, "handler not found").toBeGreaterThan(-1);
    const handlerBody = stripComments(service.slice(handlerStart, handlerStart + 1200));
    expect(handlerBody).not.toMatch(/assign/i);
  });

  it("the created task is attributed to NOBODY when it ran automatically", () => {
    // R2E-F-009: not to a fabricated system user. An automated act with a human's name on it is
    // a false audit record, and the learning loop reads those records.
    const service = readFileSync("src/kernel/execution/service.ts", "utf8");
    expect(service).toMatch(/createdBy:\s*req\.approvedBy/);
  });
});

describe("Ask-AI is advisory — it has nowhere to act from", () => {
  const askAi = readFileSync("src/kernel/ask-ai/retrieval.ts", "utf8");

  it("does not import the execution service", () => {
    expect(askAi).not.toContain("executeManagementAction");
  });

  it("does not import the catalogue of actions", () => {
    // An advisor that can name an action it may take is one refactor away from taking it.
    expect(askAi).not.toMatch(/from ["'](\.\.\/)?catalogue["']/);
  });

  it("declares no tools or callable functions to a model", () => {
    expect(askAi).not.toMatch(/\btools\s*:/);
    expect(askAi).not.toMatch(/function_call|tool_choice|functions\s*:/);
  });
});
