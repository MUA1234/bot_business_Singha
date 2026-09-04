/**
 * R2E — the executor.
 *
 * Two properties carry most of the weight here.
 *
 * **Non-execution is the default, and it is provable rather than asserted.** The disabled cases do
 * not merely check that the outcome says "refused" — they check that the executor never CALLED the
 * loaders, never touched the ledger and never invoked the handler. An outcome string is what the
 * code chose to return; a call counter is what it actually did.
 *
 * **Every refusal reason is reachable.** A closed union whose members cannot all be produced is a
 * union with dead branches, and a dead branch is a branch nobody has ever seen behave.
 */
import { describe, it, expect } from "vitest";
import { executeApprovedAction, type ExecutorDeps, type ClaimResult } from "@/kernel/execution/executor";
import { LOCAL_EXECUTION_TOKEN, EXECUTION_GLOBALLY_ENABLED } from "@/kernel/execution/boundary";
import type { ExecutionRequest, RefusalReason } from "@/kernel/execution/contract";
import { asCompanyId, asUserId } from "@/kernel/ask-ai/identity";
import type { CatalogueActionId } from "@/kernel/catalogue";

const CO = asCompanyId("11111111-1111-4111-8111-111111111111");
const USER = asUserId("22222222-2222-4222-8222-222222222222");

function request(over: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    companyId: CO,
    itemId: "33333333-3333-4333-8333-333333333333",
    actionId: "ops.task.create_internal" as CatalogueActionId,
    approvedBy: USER,
    idempotencyKey: "key-1",
    parameters: { title: "Check the delivery schedule" },
    requestedAt: new Date("2026-09-04T09:00:00.000Z"),
    ...over,
  };
}

interface Spy {
  deps: ExecutorDeps;
  calls: {
    enablement: number;
    authority: number;
    approval: number;
    item: number;
    capabilities: number;
    claim: number;
    handler: number;
    refusals: { reason: RefusalReason; detail: string }[];
    resolvedExecuted: string[];
    resolvedFailed: string[];
    audits: number;
  };
}

function harness(over: Partial<ExecutorDeps> = {}, claim?: Partial<ClaimResult>): Spy {
  const calls: Spy["calls"] = {
    enablement: 0,
    authority: 0,
    approval: 0,
    item: 0,
    capabilities: 0,
    claim: 0,
    handler: 0,
    refusals: [],
    resolvedExecuted: [],
    resolvedFailed: [],
    audits: 0,
  };

  const deps: ExecutorDeps = {
    localToken: LOCAL_EXECUTION_TOKEN,
    async companyExecutionEnabled() {
      calls.enablement++;
      return true;
    },
    async resolveAuthorityNow() {
      calls.authority++;
      return { level: "manager_approval", failedClosed: false };
    },
    async loadApproval() {
      calls.approval++;
      return {
        approvedBy: USER,
        actionId: "ops.task.create_internal",
        authority: "manager_approval",
        current: true,
      };
    },
    async loadItem() {
      calls.item++;
      return { state: "approved", evidenceCount: 2, actionId: "ops.task.create_internal" };
    },
    async approverCapabilities() {
      calls.capabilities++;
      return new Set(["operations.task.manage"]);
    },
    ledger: {
      async claim() {
        calls.claim++;
        return { ledgerId: "ledger-1", kind: "fresh", effectRef: null, ...claim } as ClaimResult;
      },
      async resolveExecuted(id) {
        calls.resolvedExecuted.push(id);
      },
      async resolveFailed(id) {
        calls.resolvedFailed.push(id);
      },
      async recordRefusal(row) {
        calls.refusals.push({ reason: row.reason, detail: row.detail });
      },
    },
    handlers: {
      "ops.task.create_internal.v1": async () => {
        calls.handler++;
        return { effectRef: "task-abc", created: true };
      },
    },
    async audit() {
      calls.audits++;
    },
    ...over,
  };

  return { deps, calls };
}

describe("R2E executor — the global boundary is a compile-time constant", () => {
  it("is off in this build", () => {
    // If this ever reads true, execution is on in every deployment built from this source.
    expect(EXECUTION_GLOBALLY_ENABLED).toBe(false);
  });

  it("without the local token, nothing is loaded, claimed, executed or even asked about", async () => {
    const h = harness({ localToken: undefined });
    const out = await executeApprovedAction(h.deps, request());

    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reason).toBe("global_boundary_disabled");

    // The point of the test: no side effect of ANY kind, including a question about the company.
    expect(h.calls).toMatchObject({
      enablement: 0,
      authority: 0,
      approval: 0,
      item: 0,
      capabilities: 0,
      claim: 0,
      handler: 0,
      audits: 0,
    });
    expect(h.calls.refusals).toEqual([]);
  });

  it("a wrong token is not a token", async () => {
    const h = harness({ localToken: "r2e-deterministic-local-test-onl" });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("global_boundary_disabled");
    expect(h.calls.enablement).toBe(0);
  });
});

describe("R2E executor — company enablement is separate from kernel enablement", () => {
  it("refuses a company with no execution enablement, and loads nothing further", async () => {
    const h = harness({ async companyExecutionEnabled() { return false; } });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("company_not_enabled");
    expect(h.calls).toMatchObject({ authority: 0, approval: 0, item: 0, claim: 0, handler: 0 });
  });

  it("an enablement lookup that THROWS is a closed boundary, not an open one", async () => {
    const h = harness({
      async companyExecutionEnabled() {
        throw new Error("connection reset");
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("company_not_enabled");
    expect(h.calls.claim).toBe(0);
  });
});

describe("R2E executor — the action and its policy", () => {
  it("refuses an action that is not registered", async () => {
    const h = harness();
    const out = await executeApprovedAction(
      h.deps,
      request({ actionId: "ops.task.invented" as CatalogueActionId }),
    );
    expect(out.status === "refused" && out.reason).toBe("action_not_registered");
    expect(h.calls.claim).toBe(0);
  });

  it("refuses a draft-only action — 13 of 15 land here", async () => {
    const h = harness();
    const out = await executeApprovedAction(
      h.deps,
      request({ actionId: "crm.followup.draft_for_human" as CatalogueActionId }),
    );
    expect(out.status === "refused" && out.reason).toBe("classification_draft_only");
    expect(h.calls.handler).toBe(0);
  });

  it("refuses a prohibited action", async () => {
    const h = harness();
    const out = await executeApprovedAction(
      h.deps,
      request({ actionId: "legal.obligation.escalate_internal" as CatalogueActionId }),
    );
    expect(out.status === "refused" && out.reason).toBe("classification_prohibited");
    expect(h.calls.handler).toBe(0);
  });

  it("refuses when the policy's handler is not registered", async () => {
    const h = harness({ handlers: {} });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("no_handler");
    expect(h.calls.claim).toBe(0);
  });

  it("refuses a blank idempotency key before loading anything", async () => {
    const h = harness();
    const out = await executeApprovedAction(h.deps, request({ idempotencyKey: "   " }));
    expect(out.status === "refused" && out.reason).toBe("idempotency_key_missing");
    expect(h.calls).toMatchObject({ authority: 0, approval: 0, item: 0, claim: 0 });
  });
});

describe("R2E executor — authority is resolved at EXECUTION time", () => {
  it("refuses when the engine fails closed", async () => {
    const h = harness({
      async resolveAuthorityNow() {
        return { level: "manager_approval", failedClosed: true };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("authority_failed_closed");
    expect(h.calls.claim).toBe(0);
    // Post-boundary refusals ARE recorded — the company is enabled, so the attempt is real.
    expect(h.calls.refusals[0]?.reason).toBe("authority_failed_closed");
  });

  it("refuses when live authority now exceeds the policy floor", async () => {
    const h = harness({
      async resolveAuthorityNow() {
        return { level: "owner_approval", failedClosed: false };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("authority_insufficient");
    expect(h.calls.handler).toBe(0);
  });
});

describe("R2E executor — the approval must still be good", () => {
  it("refuses when there is no approval", async () => {
    const h = harness({ async loadApproval() { return null; } });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("approval_missing");
  });

  it("refuses an approval a later decision replaced", async () => {
    const h = harness({
      async loadApproval() {
        return {
          approvedBy: USER,
          actionId: "ops.task.create_internal",
          authority: "manager_approval" as const,
          current: false,
        };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("approval_superseded");
    expect(h.calls.handler).toBe(0);
  });

  it("refuses an approval for a DIFFERENT action", async () => {
    const h = harness({
      async loadApproval() {
        return {
          approvedBy: USER,
          actionId: "ops.task.escalate_internal",
          authority: "manager_approval" as const,
          current: true,
        };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("approval_missing");
  });

  it("refuses an approval given by someone else", async () => {
    const h = harness({
      async loadApproval() {
        return {
          approvedBy: asUserId("99999999-9999-4999-8999-999999999999"),
          actionId: "ops.task.create_internal",
          authority: "manager_approval" as const,
          current: true,
        };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("approval_missing");
  });

  it("refuses when the approver's capability has since been revoked", async () => {
    // The whole reason capabilities are re-read: approval and execution are different moments.
    const h = harness({ async approverCapabilities() { return new Set<string>(); } });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("approver_lacks_capability");
    expect(h.calls.handler).toBe(0);
  });
});

describe("R2E executor — the world is revalidated", () => {
  it("refuses when the item has gone", async () => {
    const h = harness({ async loadItem() { return null; } });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("item_state_invalid");
  });

  it("refuses when the item now proposes a different action", async () => {
    const h = harness({
      async loadItem() {
        return { state: "approved", evidenceCount: 1, actionId: "ops.task.escalate_internal" };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("stale_state");
  });

  it("refuses from a state that does not admit execution", async () => {
    for (const state of ["observed", "recommended", "awaiting_approval", "rejected", "verified"]) {
      const h = harness({
        async loadItem() {
          return { state, evidenceCount: 1, actionId: "ops.task.create_internal" };
        },
      });
      const out = await executeApprovedAction(h.deps, request());
      expect(out.status === "refused" && out.reason, `state "${state}"`).toBe("item_state_invalid");
    }
  });

  it("refuses when the evidence has gone — the zero-evidence prohibition, re-checked", async () => {
    const h = harness({
      async loadItem() {
        return { state: "approved", evidenceCount: 0, actionId: "ops.task.create_internal" };
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("evidence_missing");
    expect(h.calls.handler).toBe(0);
  });
});

describe("R2E executor — the ledger", () => {
  it("does not execute when the ledger cannot be written", async () => {
    // A ledger that cannot record the claim cannot prevent a duplicate, so there is nothing safe
    // to do but stop.
    const h = harness();
    h.deps.ledger.claim = async () => {
      throw new Error("ledger unavailable");
    };
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status === "refused" && out.reason).toBe("ledger_unavailable");
    expect(h.calls.handler).toBe(0);
  });

  it("returns the FIRST attempt's effect on replay, and runs nothing", async () => {
    const h = harness({}, { kind: "executed", effectRef: "task-original" });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status).toBe("duplicate");
    expect(out.status === "duplicate" && out.effectRef).toBe("task-original");
    expect(h.calls.handler).toBe(0);
    expect(h.calls.audits).toBe(0);
  });

  it("resumes a crashed attempt without creating a second effect", async () => {
    // The crash signature: an `attempting` row survives, the handler is idempotent under the same
    // key, so re-invoking it returns the effect the first attempt already created.
    const h = harness({
      handlers: {
        "ops.task.create_internal.v1": async () => ({ effectRef: "task-abc", created: false }),
      },
    }, { kind: "resuming" });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status).toBe("duplicate");
    expect(out.status === "duplicate" && out.effectRef).toBe("task-abc");
    expect(h.calls.resolvedExecuted).toEqual(["ledger-1"]);
  });

  it("does not start a second attempt when a terminal one exists under the key", async () => {
    const h = harness({}, { kind: "failed" });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status).toBe("failed");
    expect(h.calls.handler).toBe(0);
  });

  it("records a handler failure as failed, asserting no effect", async () => {
    const h = harness({
      handlers: {
        "ops.task.create_internal.v1": async () => {
          throw new Error("insert violates check constraint");
        },
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.error).toContain("check constraint");
    expect(h.calls.resolvedFailed).toEqual(["ledger-1"]);
    expect(h.calls.resolvedExecuted).toEqual([]);
    expect(h.calls.audits).toBe(0);
  });
});

describe("R2E executor — the one path that produces an effect", () => {
  it("executes when every condition holds, and audits it", async () => {
    const h = harness();
    const out = await executeApprovedAction(h.deps, request());

    expect(out.status).toBe("executed");
    expect(out.status === "executed" && out.effectRef).toBe("task-abc");
    expect(out.status === "executed" && out.handler).toBe("ops.task.create_internal.v1");
    expect(h.calls.handler).toBe(1);
    expect(h.calls.resolvedExecuted).toEqual(["ledger-1"]);
    expect(h.calls.audits).toBe(1);
  });

  it("an audit failure is NOT reported as a refusal", async () => {
    // The effect exists. Saying "refused" would be the more dangerous lie, so the throw escapes.
    const h = harness({
      async audit() {
        throw new Error("audit sink unreachable");
      },
    });
    const out = await executeApprovedAction(h.deps, request());
    // `failed`, but never mistakable for "nothing happened": the effect ref is named, and the
    // ledger was NOT rewritten — a truthful executed record stands.
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.error).toContain("task-abc");
    expect(out.status === "failed" && out.error).toContain("audit event failed");
    expect(h.calls.handler).toBe(1);
    expect(h.calls.resolvedExecuted).toEqual(["ledger-1"]);
    expect(h.calls.resolvedFailed).toEqual([]);
  });

  it("checks the conditions in the documented order", async () => {
    // Ordering is a safety property: a disabled system must not reveal whether a company exists,
    // and a draft-only action must not cause an approval lookup.
    const h = harness();
    await executeApprovedAction(
      h.deps,
      request({ actionId: "marketing.campaign.review_internal" as CatalogueActionId }),
    );
    expect(h.calls.enablement).toBe(1);
    expect(h.calls.authority).toBe(0);
    expect(h.calls.approval).toBe(0);
  });
});
