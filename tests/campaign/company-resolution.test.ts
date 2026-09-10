/**
 * FOUND-003 — which company received the message.
 *
 * The rule under test is FAIL-CLOSED: only a definite company may carry a message into business
 * processing. Everything else — an unmapped number, an ambiguous mapping, a missing metadata field,
 * a database error — stops the message, leaving it durably persisted and reported rather than
 * attributed to whichever company happens to be convenient.
 */
import { describe, it, expect, vi } from "vitest";
import { isUsableCompany, resolveReceivingCompany, type ResolvedCompany } from "@/lib/inbound/company-resolution";

const CO = "11111111-1111-1111-1111-111111111111";
const deps = (r: ResolvedCompany) => ({ resolveCompany: vi.fn(async () => r) });

describe("FOUND-003 receiving-company resolution", () => {
  it("an exactly-mapped account resolves and is usable", async () => {
    const r = await resolveReceivingCompany(deps({ companyId: CO, match: "exact" }), "whatsapp", "10555");
    expect(r).toEqual({ companyId: CO, match: "exact" });
    expect(isUsableCompany(r)).toBe(true);
  });

  it("the documented single-tenant bridge is usable, and says which it was", async () => {
    const r = await resolveReceivingCompany(deps({ companyId: CO, match: "single_tenant_fallback" }), "whatsapp", "10555");
    expect(isUsableCompany(r)).toBe(true);
    expect(r.match).toBe("single_tenant_fallback"); // never reported as configured
  });

  for (const bad of ["unmapped", "ambiguous", "empty", "lookup_error"] as const) {
    it(`${bad} is NOT usable — the message is not processed`, () => {
      expect(isUsableCompany({ companyId: null, match: bad })).toBe(false);
    });
  }

  it("a company id WITHOUT a definite match is still refused", () => {
    // Defence in depth: a resolver that returned a company alongside an inconclusive match must not
    // be taken at its word.
    expect(isUsableCompany({ companyId: CO, match: "ambiguous" })).toBe(false);
    expect(isUsableCompany({ companyId: CO, match: "unmapped" })).toBe(false);
  });

  it("a missing receiving account is not looked up at all", async () => {
    const d = deps({ companyId: CO, match: "exact" });
    for (const missing of [null, undefined, "", "   "]) {
      const r = await resolveReceivingCompany(d, "whatsapp", missing);
      expect(r).toEqual({ companyId: null, match: "empty" });
    }
    expect(d.resolveCompany).not.toHaveBeenCalled();
  });

  it("the account id is trimmed before lookup", async () => {
    const d = deps({ companyId: CO, match: "exact" });
    await resolveReceivingCompany(d, "whatsapp", "  10555  ");
    expect(d.resolveCompany).toHaveBeenCalledWith("whatsapp", "10555");
  });
});
