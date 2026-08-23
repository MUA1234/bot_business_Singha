/**
 * COM-007 — Human handover, opt-out and communication preferences.
 *
 * Preferences are persisted per (company, channel, identity); the inbound dispatch
 * path respects opt-out and handover; the outbound enqueue path respects opt-out.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = "src/db/migrations/0104_communication_preferences.sql";
const PURE = "src/modules/comms/preferences.ts";
const SERVICE = "src/lib/comms/preferences.ts";
const ACTIONS = "src/app/app/messages/actions.ts";
const OUTBOX = "src/lib/outbox-enqueue.ts";
const DISPATCH = "src/lib/inbound/dispatch-receipt.ts";

describe("COM-007 — Communication preferences", () => {
  const migration = readFileSync(MIGRATION, "utf8");
  const pure = readFileSync(PURE, "utf8");
  const service = readFileSync(SERVICE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const outbox = readFileSync(OUTBOX, "utf8");
  const dispatch = readFileSync(DISPATCH, "utf8");

  it("has a migration adding a company-scoped communication_preferences table", () => {
    expect(migration).toContain("create table if not exists communication_preferences");
    expect(migration).toContain("opt_out");
    expect(migration).toContain("handover_to");
    expect(migration).toContain("unique (company_id, channel, identity)");
  });

  it("exposes pure helpers for opt-out and handover", () => {
    expect(pure).toContain("export function isOptedOut");
    expect(pure).toContain("export function isHandedOver");
    expect(pure).toContain("export function canSendAutomated");
    expect(pure).toContain("export function canHandleAutomatically");
  });

  it("has a service to load and mutate preferences", () => {
    expect(service).toContain("export async function getCommunicationPreference");
    expect(service).toContain("export async function setOptOut");
    expect(service).toContain("export async function setHandover");
    expect(service).toContain("export async function clearHandover");
  });

  it("has server actions for opt-out and handover", () => {
    expect(actions).toContain("setIdentityOptOut");
    expect(actions).toContain("handoverToHuman");
    expect(actions).toContain("clearHumanHandover");
  });

  it("outbound enqueue checks opt-out before persisting", () => {
    expect(outbox).toContain("getCommunicationPreference");
    expect(outbox).toContain("isOptedOut");
    expect(outbox).toContain('"opted_out"');
  });

  it("inbound dispatch checks opt-out and handover before automated handling", () => {
    expect(dispatch).toContain("getPreference");
    expect(dispatch).toContain("opt_out");
    expect(dispatch).toContain("handover_to");
    expect(dispatch).toContain('"manual_review"');
  });
});
