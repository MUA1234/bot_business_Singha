/**
 * AIM-002 — the business identity an analysis attaches to each proposed task.
 *
 * The fingerprint itself is computed in PostgreSQL (migration 0071) and proven in
 * tests/integration/case-task-dedup-wiring.test.ts. What is proven HERE is the decision this
 * module owns: which facts are offered, that they normalise the way the database does, and that
 * the two analysis paths are scoped differently on purpose.
 */
import { describe, it, expect } from "vitest";
import {
  manualIdentity,
  occurrenceWindow,
  purposeFromTitle,
  taskIdentityParts,
  threadIdentity,
} from "@/management/ai-manager/task-identity";

const AT = new Date("2026-08-18T10:00:00.000Z");

describe("AIM-002 task identity", () => {
  it("normalises case, surrounding and internal whitespace — the DB rule, mirrored", () => {
    expect(purposeFromTitle("  Chase   the DELIVERY  ")).toBe("chase the delivery");
    expect(purposeFromTitle("Chase the delivery")).toBe(purposeFromTitle("CHASE  THE\tDELIVERY"));
  });

  it("bounds the purpose so an oversized model title cannot become an oversized key", () => {
    expect(purposeFromTitle("x".repeat(1000)).length).toBe(256);
  });

  it("a title with no content has no identity — the DB must not guess two unnamed tasks are one", () => {
    expect(taskIdentityParts("   ", threadIdentity("conv-1", AT))).toBeNull();
  });

  it("thread identity is scoped to the CONVERSATION, not the message or the case", () => {
    const parts = taskIdentityParts("Chase delivery", threadIdentity("conv-1", AT));
    expect(parts).toEqual({
      source_type: "wa_thread",
      source_id: "conv-1",
      purpose: "chase delivery",
      target: null,
      window: "2026-08-18",
    });
  });

  it("two conversations produce different identities — distinct customers are distinct work", () => {
    const a = taskIdentityParts("Confirm payment", threadIdentity("conv-1", AT));
    const b = taskIdentityParts("Confirm payment", threadIdentity("conv-2", AT));
    expect(a!.source_id).not.toBe(b!.source_id);
  });

  it("manual identity is scoped to the SUBMITTED CONTENT — two updates never merge on title alone", () => {
    const a = taskIdentityParts("Call supplier", manualIdentity("hash-of-update-A", AT));
    const b = taskIdentityParts("Call supplier", manualIdentity("hash-of-update-B", AT));
    expect(a!.source_type).toBe("manual_analysis");
    expect(a!.source_id).not.toBe(b!.source_id);
  });

  it("the occurrence window is the UTC date, so the same purpose tomorrow is new work", () => {
    expect(occurrenceWindow(new Date("2026-08-18T23:59:59.000Z"))).toBe("2026-08-18");
    expect(occurrenceWindow(new Date("2026-08-19T00:00:01.000Z"))).toBe("2026-08-19");
  });

  it("no target entity is taken from free text — model-written text cannot change an identity", () => {
    expect(taskIdentityParts("Refund customer Perera", threadIdentity("conv-1", AT))!.target).toBeNull();
  });

  it("every component stays within the bounds create_task_deduplicated enforces", () => {
    const parts = taskIdentityParts("y".repeat(2000), threadIdentity("c".repeat(2000), AT))!;
    expect(parts.source_type.length).toBeLessThanOrEqual(64);
    expect(parts.source_id!.length).toBeLessThanOrEqual(512);
    expect(parts.purpose.length).toBeLessThanOrEqual(256);
    expect(parts.window.length).toBeLessThanOrEqual(64);
  });
});
