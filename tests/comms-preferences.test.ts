import { describe, it, expect } from "vitest";
import {
  isOptedOut,
  isHandedOver,
  canSendAutomated,
  canHandleAutomatically,
  type CommunicationPreference,
} from "@/modules/comms/preferences";

const pref = (over: Partial<CommunicationPreference> = {}): CommunicationPreference => ({
  company_id: "co-1",
  channel: "whatsapp",
  identity: "94770001111",
  opt_out: false,
  handover_to: null,
  handover_at: null,
  handover_reason: null,
  ...over,
});

describe("COM-007 communication preference helpers", () => {
  it("opt-out blocks automated sends but still allows inbound handling", () => {
    const p = pref({ opt_out: true });
    expect(isOptedOut(p)).toBe(true);
    expect(canSendAutomated(p)).toBe(false);
    expect(isHandedOver(p)).toBe(false);
    expect(canHandleAutomatically(p)).toBe(true);
  });

  it("handover blocks automated inbound handling but still allows sends", () => {
    const p = pref({ handover_to: "u-1", handover_at: new Date().toISOString() });
    expect(isHandedOver(p)).toBe(true);
    expect(canHandleAutomatically(p)).toBe(false);
    expect(isOptedOut(p)).toBe(false);
    expect(canSendAutomated(p)).toBe(true);
  });

  it("null preference means no restrictions", () => {
    expect(isOptedOut(null)).toBe(false);
    expect(isHandedOver(null)).toBe(false);
    expect(canSendAutomated(null)).toBe(true);
    expect(canHandleAutomatically(null)).toBe(true);
  });

  it("opt-out and handover can both be active", () => {
    const p = pref({ opt_out: true, handover_to: "u-1" });
    expect(isOptedOut(p)).toBe(true);
    expect(isHandedOver(p)).toBe(true);
    expect(canSendAutomated(p)).toBe(false);
    expect(canHandleAutomatically(p)).toBe(false);
  });
});
