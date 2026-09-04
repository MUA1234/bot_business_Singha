/**
 * R2E — the execution policy table.
 *
 * The owner's direction on R2E-F-001 is specific about how the divergent vocabulary must NOT be
 * repaired: no fuzzy matching, no prefix matching, no normalised aliases, no fallback tiers, and no
 * single mapping that accidentally covers several actions. Every one of those shares a property —
 * an action can acquire an authority it was never individually granted, because it resembles one
 * that was. These tests are what make that property absent rather than merely unintended.
 */
import { describe, it, expect } from "vitest";
import { ACTION_CATALOGUE, type CatalogueActionId } from "@/kernel/catalogue";
import {
  allPolicies,
  classificationFor,
  handlerFor,
  locallyExecutableActions,
  policyFor,
} from "@/kernel/execution/policy";
import type { AuthorityLevel } from "@/schemas/management";

const LADDER: AuthorityLevel[] = [
  "automatic",
  "policy_controlled",
  "manager_approval",
  "specialist_approval",
  "owner_approval",
];
const rank = (l: AuthorityLevel) => LADDER.indexOf(l);

/**
 * THE expected-policy fixture.
 *
 * Restated here deliberately rather than derived from the table under test — a test that computes
 * its expectation from the thing it is testing asserts only that the code is self-consistent.
 * Changing any action's classification, floor or handler must edit BOTH, in one reviewable diff.
 */
const EXPECTED: Record<CatalogueActionId, [string, AuthorityLevel, string | null]> = {
  "ops.task.create_internal": ["locally_executable", "manager_approval", "ops.task.create_internal.v1"],
  "ops.task.reminder_internal": ["draft_only", "manager_approval", null],
  "ops.task.request_progress_update": ["draft_only", "manager_approval", null],
  "ops.task.escalate_internal": ["draft_only", "manager_approval", null],
  "finance.invoice.flag_for_review": ["draft_only", "specialist_approval", null],
  "crm.followup.draft_for_human": ["draft_only", "manager_approval", null],
  "workforce.capacity.review_allocation": ["draft_only", "manager_approval", null],
  "governance.directive.chase_internal": ["draft_only", "manager_approval", null],
  "objectives.objective.review_internal": ["draft_only", "manager_approval", null],
  "marketing.campaign.review_internal": ["draft_only", "manager_approval", null],
  "procurement.stock.review_internal": ["draft_only", "manager_approval", null],
  "assets.document.schedule_renewal_internal": ["draft_only", "manager_approval", null],
  "legal.obligation.escalate_internal": ["prohibited", "specialist_approval", null],
  "providers.provider.review_internal": ["draft_only", "manager_approval", null],
  "system.health.investigate_internal": ["draft_only", "manager_approval", null],
};

describe("R2E execution policy — exhaustive and exact", () => {
  it("covers every catalogue action, and nothing else", () => {
    const catalogue = ACTION_CATALOGUE.map((a) => a.id).sort();
    const policies = allPolicies()
      .map(([id]) => id)
      .sort();
    expect(policies).toEqual(catalogue);
    expect(Object.keys(EXPECTED).sort()).toEqual(catalogue);
  });

  it("matches the expected policy exactly — classification, floor and handler", () => {
    for (const a of ACTION_CATALOGUE) {
      const p = policyFor(a.id);
      expect(p, `${a.id} has a policy`).not.toBeNull();
      const [classification, floor, handler] = EXPECTED[a.id];
      expect(p!.classification, `${a.id} classification`).toBe(classification);
      expect(p!.authorityFloor, `${a.id} authority floor`).toBe(floor);
      expect(p!.handler, `${a.id} handler`).toBe(handler);
    }
  });

  it("no action is `automatic`, and promoting one fails this test", () => {
    // R2E-F-001 direction: unattended execution stays fail-closed until Batch 6 proves the whole
    // authority path. An `automatic` floor appearing here is the signal that it did not.
    const automatic = allPolicies().filter(([, p]) => p.authorityFloor === "automatic");
    expect(automatic.map(([id]) => id)).toEqual([]);
  });

  it("exactly one action is locally executable", () => {
    expect(locallyExecutableActions()).toEqual(["ops.task.create_internal"]);
  });

  it("a policy floor is never BELOW the catalogue's own floor", () => {
    for (const a of ACTION_CATALOGUE) {
      const p = policyFor(a.id)!;
      expect(
        rank(p.authorityFloor) >= rank(a.authorityFloor),
        `${a.id}: policy ${p.authorityFloor} must not be below catalogue ${a.authorityFloor}`,
      ).toBe(true);
    }
  });

  it("only a locally_executable action may name a handler", () => {
    for (const [id, p] of allPolicies()) {
      if (p.classification !== "locally_executable") {
        expect(p.handler, `${id} must name no handler`).toBeNull();
        expect(handlerFor(id), `${id} handlerFor`).toBeNull();
      } else {
        expect(p.handler, `${id} must name a handler`).not.toBeNull();
      }
    }
  });
});

describe("R2E execution policy — lookups fail closed and never approximate", () => {
  it("an unknown action is prohibited, not defaulted to a tier", () => {
    expect(policyFor("not.an.action")).toBeNull();
    expect(classificationFor("not.an.action")).toBe("prohibited");
    expect(handlerFor("not.an.action")).toBeNull();
  });

  it("no PREFIX of a real action inherits its policy", () => {
    // `ops.task.create_internal` is the one executable action. Nothing that merely starts like it,
    // or that it starts like, may borrow that.
    for (const near of [
      "ops.task.create",
      "ops.task",
      "ops",
      "ops.task.create_internal.extra",
      "ops.task.create_internal_v2",
    ]) {
      expect(policyFor(near), `prefix/extension "${near}"`).toBeNull();
      expect(classificationFor(near)).toBe("prohibited");
      expect(handlerFor(near)).toBeNull();
    }
  });

  it("no normalised or folded variant matches", () => {
    // These are the exact evasion classes defect D-001 confirmed against a substring list:
    // separators, case, and fullwidth unicode.
    for (const variant of [
      "opstaskcreateinternal",
      "ops-task-create-internal",
      "OPS.TASK.CREATE_INTERNAL",
      "Ops.Task.Create_Internal",
      "ｏｐｓ.ｔａｓｋ.ｃｒｅａｔｅ＿ｉｎｔｅｒｎａｌ",
      " ops.task.create_internal",
      "ops.task.create_internal ",
    ]) {
      expect(policyFor(variant), `variant "${variant}"`).toBeNull();
      expect(handlerFor(variant), `variant "${variant}"`).toBeNull();
    }
  });

  it("a prototype key is not a policy", () => {
    // A bare index read would return `Object.prototype.constructor` — a truthy non-policy object,
    // whose `.classification` is undefined and would read as "not prohibited" downstream.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(policyFor(key), `prototype key "${key}"`).toBeNull();
      expect(classificationFor(key)).toBe("prohibited");
    }
  });

  it("every catalogue action is internal-only and reversible, as the policy assumes", () => {
    for (const a of ACTION_CATALOGUE) {
      expect(a.internalOnly, `${a.id} internalOnly`).toBe(true);
      expect(a.reversible, `${a.id} reversible`).toBe(true);
    }
  });
});
