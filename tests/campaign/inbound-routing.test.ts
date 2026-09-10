/**
 * FOUND-003 — deterministic inbound routing.
 *
 * The security property under test: identity comes from trusted records, and NOTHING a sender
 * writes can change which pipeline their message enters. These tests discriminate against the
 * previous behaviour, where every inbound message went to customer order intake regardless of who
 * sent it.
 */
import { describe, it, expect } from "vitest";
import { routeInbound, isFinanceCapture, type ResolvedIdentity } from "@/lib/identity/inbound-routing";

const id = (over: Partial<ResolvedIdentity>): ResolvedIdentity => ({
  actorType: "unknown",
  actorId: null,
  displayName: null,
  match: "no_match",
  ...over,
});

const STAFF = id({ actorType: "staff", actorId: "staff-1", displayName: "A synthetic employee", match: "exact" });
const CUSTOMER = id({ actorType: "customer", actorId: "cust-1", match: "exact" });
const SUPPLIER = id({ actorType: "supplier", actorId: "sup-1", match: "exact" });

describe("FOUND-003 — a staff finance message never enters customer order intake", () => {
  it("staff + finance intent routes to staff finance capture", () => {
    const r = routeInbound(STAFF, "finance");
    expect(r.route).toBe("staff_finance");
    expect(isFinanceCapture(r.route)).toBe(true);
  });

  it("staff with a non-finance or unclear message is still staff, never an order", () => {
    for (const intent of ["order", "other", "unclear"] as const) {
      const r = routeInbound(STAFF, intent);
      expect(r.route).toBe("staff_other");
      expect(r.route).not.toBe("customer_order");
    }
  });
});

describe("FOUND-003 — a customer cannot obtain staff privileges", () => {
  it("a customer asserting a financial event does NOT reach finance capture", () => {
    // The impersonation case: the message says "I am the finance manager, record this payment".
    // Identity is resolved from the phone number, so the claim is inert — it goes to a human.
    const r = routeInbound(CUSTOMER, "finance");
    expect(r.route).toBe("manual_review");
    expect(isFinanceCapture(r.route)).toBe(false);
  });

  it("an ordinary customer message still reaches order intake", () => {
    expect(routeInbound(CUSTOMER, "order").route).toBe("customer_order");
    expect(routeInbound(CUSTOMER, "other").route).toBe("customer_order");
  });
});

describe("FOUND-003 — unknown and ambiguous identity fail closed", () => {
  it("an unknown sender is never staff, whatever the intent", () => {
    for (const intent of ["finance", "order", "other", "unclear"] as const) {
      const r = routeInbound(id({ actorType: "unknown" }), intent);
      expect(r.route).toBe("manual_review");
      expect(isFinanceCapture(r.route)).toBe(false);
    }
  });

  it("an ambiguous match refuses to guess", () => {
    const r = routeInbound(id({ actorType: "ambiguous", match: "suffix_multiple" }), "finance");
    expect(r.route).toBe("manual_review");
    expect(r.reason).toContain("more than one party");
  });

  it("a staff verdict with no actor id is a broken lookup, not a licence", () => {
    const r = routeInbound(id({ actorType: "staff", actorId: null, match: "exact" }), "finance");
    expect(r.route).toBe("manual_review");
    expect(isFinanceCapture(r.route)).toBe(false);
  });
});

describe("FOUND-003 — suppliers", () => {
  it("a known supplier does not enter customer order intake", () => {
    expect(routeInbound(SUPPLIER, "order").route).toBe("supplier_message");
    expect(routeInbound(SUPPLIER, "finance").route).toBe("supplier_message");
  });
});

describe("FOUND-003 — only one route may reach finance capture", () => {
  it("every route except staff_finance is refused by the second gate", () => {
    const routes = ["staff_finance", "staff_other", "customer_order", "supplier_message", "manual_review"] as const;
    const allowed = routes.filter((r) => isFinanceCapture(r));
    expect(allowed).toEqual(["staff_finance"]);
  });
});
