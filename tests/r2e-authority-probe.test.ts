/**
 * R2E-F-001 gate — the catalogue's `automatic` tier is currently UNREACHABLE.
 *
 * This test pins a measured fact, not a desired one.
 *
 * `resolveRequiredAuthority` classifies against `ACTION_FLOORS`, a closed list matched by EXACT
 * membership on a normalised key. The catalogue and that list were written in different
 * vocabularies — the engine knows `opstaskcreate`, the catalogue registers
 * `ops.task.create_internal` → `opstaskcreateinternal` — so every catalogue id is UNKNOWN to the
 * engine, escalates to at least `manager_approval`, and sets `failedClosed`.
 *
 * The consequence is that `recommend()`'s `mayRunUnattended` cannot be true for any input, and
 * `assertTransition`'s D-9 `recommended → assigned` bypass is unreachable from the real pipeline.
 *
 * That fails SAFE. The danger is that it is invisible: adding one string to `ACTION_FLOORS` would
 * switch on unattended execution for up to five actions, and — measured by mutation — not one test
 * in the 2196-test suite would fail. Replacing `mayRunUnattended` with a hard-coded `false` SURVIVED
 * the entire suite, because all eleven existing assertions on that field assert `false` and none
 * asserts `true`.
 *
 * So this gate asserts the CURRENT classification exactly. If someone teaches the engine a
 * catalogue id, this test fails and names it. That is the intended outcome: the change is then a
 * deliberate, reviewed authority decision rather than a silent one. Fixing the vocabulary mismatch
 * belongs to R2E Batch 6, together with the tests that must discriminate the new behaviour.
 *
 * See docs/product-recovery/r2e/00-AUDIT.md § R2E-F-001.
 */
import { describe, it, expect } from "vitest";
import { ACTION_CATALOGUE } from "@/kernel/catalogue";
import {
  actionFloor,
  normalizeAction,
  resolveRequiredAuthority,
  type AuthorityContext,
} from "@/policy/authority-engine";
import type { AuthorityLevel } from "@/schemas/management";

/**
 * The most permissive context the engine accepts: an active policy, a known actor, and an
 * unlimited company-wide rule. Nothing here can escalate, so whatever the engine returns is
 * attributable to the ACTION classification alone.
 */
const PERMISSIVE: AuthorityContext = {
  companyId: "00000000-0000-0000-0000-0000000000c1",
  actorMembershipId: "00000000-0000-0000-0000-0000000000a1",
  rules: [
    {
      id: "rule-1",
      membership_id: "00000000-0000-0000-0000-0000000000a1",
      company_id: "00000000-0000-0000-0000-0000000000c1",
      domain: null,
      max_amount: null,
      currency: null,
      is_unlimited: true,
      is_company_wide: true,
    },
  ],
  policyPresent: true,
};

function resolveFor(action: (typeof ACTION_CATALOGUE)[number]) {
  return resolveRequiredAuthority(
    {
      domain: action.department === "operations" ? "ops" : action.department,
      action: action.id,
      impact: {
        financial: action.department === "finance",
        customer: action.department === "crm",
        operational: action.department === "operations" || action.department === "system",
      },
      confidence: 0.99,
    },
    PERMISSIVE,
  );
}

describe("R2E-F-001 — catalogue ids are unknown to the authority classification", () => {
  it("every catalogue id normalises to a key the engine does not classify", () => {
    const classified = ACTION_CATALOGUE.filter((a) => actionFloor(a.id) !== null).map(
      (a) => `${a.id} (${normalizeAction(a.id)}) → ${actionFloor(a.id)}`,
    );
    // If this fails, someone taught the engine a catalogue id. That is an AUTHORITY change:
    // read docs/product-recovery/r2e/00-AUDIT.md § R2E-F-001 before updating this expectation.
    expect(
      classified,
      "catalogue ids newly known to ACTION_FLOORS — unattended execution may now be reachable",
    ).toEqual([]);
  });

  it("every catalogue action therefore fails closed, above `automatic`", () => {
    const rows = ACTION_CATALOGUE.map((a) => {
      const r = resolveFor(a);
      return { id: a.id, level: r.level, failedClosed: r.failedClosed };
    });

    const notFailedClosed = rows.filter((r) => !r.failedClosed);
    expect(notFailedClosed, "actions no longer failing closed").toEqual([]);

    const automatic = rows.filter((r) => r.level === "automatic");
    expect(automatic, "actions now resolving to `automatic` authority").toEqual([]);
  });

  it("the five catalogue-`automatic` actions are not automatic in the running system", () => {
    // The catalogue advertises these as automatic + automaticSafe. The engine disagrees, and the
    // engine is what runs. Recorded so the discrepancy is visible rather than implied.
    const advertised = ACTION_CATALOGUE.filter(
      (a) => a.authorityFloor === "automatic" && a.automaticSafe === true,
    );
    expect(advertised.map((a) => a.id)).toEqual([
      "ops.task.create_internal",
      "ops.task.reminder_internal",
      "ops.task.request_progress_update",
      "ops.task.escalate_internal",
      "system.health.investigate_internal",
    ]);

    for (const a of advertised) {
      const r = resolveFor(a);
      const level: AuthorityLevel = r.level;
      expect(level, `${a.id} resolved authority`).not.toBe("automatic");
      expect(r.failedClosed, `${a.id} failedClosed`).toBe(true);
    }
  });
});
