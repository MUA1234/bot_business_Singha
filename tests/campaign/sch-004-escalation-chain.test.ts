/**
 * SCH-004 — Escalation and missed-response recovery.
 *
 * The follow-ups cron route must support a defined per-task escalation chain,
 * advance one step per escalation sweep, recover missed responses by continuing
 * to advance, and fall back to company admins only when the chain is exhausted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE = "src/app/api/cron/follow-ups/route.ts";
const FOLLOW_UP = "src/modules/work/follow-up.ts";
const ACTIONS = "src/app/app/operations/tasks/actions.ts";

describe("SCH-004 — Escalation and missed-response recovery", () => {
  const route = readFileSync(ROUTE, "utf8");
  const followUp = readFileSync(FOLLOW_UP, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");

  it("reads escalation chain and level from tasks", () => {
    expect(route).toContain("escalation_chain");
    expect(route).toContain("escalation_level");
    expect(route).toContain("escalated_to");
    expect(route).toContain("last_reminder_at");
  });

  it("uses the deterministic escalation-target selector", () => {
    expect(route).toContain("selectEscalationTarget");
    expect(followUp).toContain("export function selectEscalationTarget");
  });

  it("advances the chain one step per escalation", () => {
    expect(route).toContain("escalation_level: nextLevel");
    expect(route).toContain("escalated_to: targetId");
    expect(route).toContain('status: "escalated"');
  });

  it("falls back to company admins when the chain is exhausted", () => {
    expect(route).toContain("adminsByCompany");
    expect(route).toContain("chain_exhausted");
  });

  it("passes last_reminder_at to the follow-up engine to avoid spam", () => {
    expect(route).toContain("lastReminderAt: t.last_reminder_at");
  });

  it("persists reminder/escalation state after sending", () => {
    expect(route).toContain("last_reminder_at: now");
    expect(route).toContain('from("tasks").update');
  });

  it("recovers missed responses by re-escalating an escalated task", () => {
    // The route keeps sending escalation actions for tasks already in escalated status,
    // advancing the chain until exhausted, then falling back to admins.
    expect(route).toContain("decision.action === \"escalation\"");
    expect(followUp).toContain('task.status === "escalated"');
  });

  it("provides a server action to set the escalation chain", () => {
    expect(actions).toContain("setTaskEscalationChain");
    expect(actions).toContain("task.escalation_chain_set");
  });
});
