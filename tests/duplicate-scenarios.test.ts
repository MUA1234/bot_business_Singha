/**
 * The duplicate scorer, scenario by scenario (owner directive A2).
 *
 * Duplicate detection was found to declare a duplicate on evidence it did not have, and the
 * pipeline wrote a TERMINAL state from that score — so a second genuine payment was silently and
 * irreversibly discarded. These are the named scenarios, each with its measured outcome.
 *
 * The rule under test: a suspicion requires identical amount AND date proximity AND a counterparty
 * signal. Missing evidence is never a match — two absent counterparties are not matching
 * counterparties, and two absent dates are not date proximity.
 */
import { describe, it, expect } from "vitest";
import { scoreDuplicate, DUPLICATE_ALGORITHM_VERSION, type DuplicateCandidateInput } from "@/events/duplicate";

const CO = "11111111-1111-1111-1111-111111111111";
const OTHER_CO = "22222222-2222-2222-2222-222222222222";

const ev = (over: Partial<DuplicateCandidateInput> = {}): DuplicateCandidateInput => ({
  company_id: CO,
  amount: "45000.00",
  currency: "LKR",
  transaction_date: "2026-08-01",
  counterparty_name: "Acme Cement",
  ...over,
});

describe("duplicate suspicion — the scenarios that must NOT be suspected", () => {
  it("two legitimate payments, same amount, same day, DIFFERENT suppliers", () => {
    const s = scoreDuplicate(ev({ counterparty_name: "Ceylon Steel" }), ev());
    expect(s.score).toBeCloseTo(0.8, 4);          // the old rule flagged this
    expect(s.isLikelyDuplicate).toBe(false);      // no counterparty evidence at all
    expect(s.evidenceMissing).toContain("counterparty match");
  });

  it("same amount, different suppliers, a day apart", () => {
    const s = scoreDuplicate(
      ev({ counterparty_name: "Metro Traders", transaction_date: "2026-08-02" }), ev());
    expect(s.isLikelyDuplicate).toBe(false);
  });

  it("recurring rent / salary / instalment — same supplier, same amount, a month apart", () => {
    const s = scoreDuplicate(ev({ transaction_date: "2026-09-01" }), ev());
    expect(s.score).toBeCloseTo(0.7, 4);          // EXACTLY the old threshold
    expect(s.isLikelyDuplicate).toBe(false);      // no date proximity
    expect(s.evidenceMissing).toContain("date proximity");
  });

  it("identical GENERIC descriptions with no counterparty on either side", () => {
    const s = scoreDuplicate(ev({ counterparty_name: null }), ev({ counterparty_name: null }));
    expect(s.score).toBeCloseTo(0.8, 4);
    expect(s.isLikelyDuplicate).toBe(false);
    expect(s.evidenceMissing).toContain("counterparty");
  });

  it("counterparty missing on ONE side only", () => {
    const s = scoreDuplicate(ev({ counterparty_name: null }), ev());
    expect(s.isLikelyDuplicate).toBe(false);
    expect(s.evidenceMissing).toContain("counterparty");
  });

  it("dates missing on one or both sides", () => {
    expect(scoreDuplicate(ev({ transaction_date: null }), ev()).isLikelyDuplicate).toBe(false);
    const both = scoreDuplicate(ev({ transaction_date: null }), ev({ transaction_date: null }));
    expect(both.isLikelyDuplicate).toBe(false);
    expect(both.evidenceMissing).toContain("transaction date");
  });

  it("cross-company similarity is never a duplicate, however identical", () => {
    const s = scoreDuplicate(ev({ company_id: OTHER_CO }), ev());
    expect(s.score).toBe(0);
    expect(s.isLikelyDuplicate).toBe(false);
    expect(s.reasons).toContain("different company");
  });

  it("the same amount in a DIFFERENT currency is not a match", () => {
    const s = scoreDuplicate(ev({ currency: "USD" }), ev());
    expect(s.contributions.amount).toBe(0);
    expect(s.isLikelyDuplicate).toBe(false);
    expect(s.evidenceMissing).toContain("comparable currency");
  });

  it("delayed message just OUTSIDE the window", () => {
    const s = scoreDuplicate(ev({ transaction_date: "2026-08-05" }), ev());  // 4 days
    expect(s.contributions.date).toBe(0);
    expect(s.isLikelyDuplicate).toBe(false);
  });

  it("a paraphrased counterparty that shares no token is not corroboration", () => {
    const s = scoreDuplicate(ev({ counterparty_name: "The Cement People" }), ev({ counterparty_name: "Acme" }));
    expect(s.contributions.counterparty).toBe(0);
    expect(s.isLikelyDuplicate).toBe(false);
  });
});

describe("duplicate suspicion — the scenarios that SHOULD be suspected", () => {
  it("the same payment described twice: same amount, same day, same supplier", () => {
    const s = scoreDuplicate(ev(), ev());
    expect(s.score).toBe(1);
    expect(s.isLikelyDuplicate).toBe(true);
    expect(s.evidencePresent.sort()).toEqual(["amount", "counterparty", "transaction date"]);
    expect(s.contributions.amount).toBe(0.5);
    expect(s.contributions.date).toBeCloseTo(0.3, 4);
    expect(s.contributions.counterparty).toBeCloseTo(0.2, 4);
  });

  it("same supplier and amount, one day apart — genuinely ambiguous, so a person decides", () => {
    const s = scoreDuplicate(ev({ transaction_date: "2026-08-02" }), ev());
    expect(s.isLikelyDuplicate).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(0.7);
  });

  it("a paraphrased duplicate that still shares the supplier name", () => {
    const s = scoreDuplicate(ev({ counterparty_name: "Acme Cement Ltd" }), ev());
    expect(s.contributions.counterparty).toBeGreaterThan(0);
    expect(s.isLikelyDuplicate).toBe(true);
  });

  it("the boundary: exactly at the window edge contributes nothing, so it is not suspected", () => {
    const at = scoreDuplicate(ev({ transaction_date: "2026-08-04" }), ev());  // exactly 3 days
    expect(at.contributions.date).toBe(0);
    expect(at.isLikelyDuplicate).toBe(false);
    const inside = scoreDuplicate(ev({ transaction_date: "2026-08-03" }), ev());
    expect(inside.contributions.date).toBeGreaterThan(0);
    expect(inside.isLikelyDuplicate).toBe(true);
  });
});

describe("the evidence record a reviewer sees", () => {
  it("every suspicion carries its per-feature contributions and its rule version", () => {
    const s = scoreDuplicate(ev(), ev());
    expect(Object.keys(s.contributions).sort()).toEqual(["amount", "counterparty", "date"]);
    expect(s.contributions.amount + s.contributions.date + s.contributions.counterparty)
      .toBeCloseTo(s.score, 4);
    expect(DUPLICATE_ALGORITHM_VERSION).toBe("dup/v2-evidence-required");
  });

  it("what was MISSING is recorded, not silently treated as agreement", () => {
    const s = scoreDuplicate(
      ev({ counterparty_name: null, transaction_date: null }),
      ev({ counterparty_name: null, transaction_date: null }),
    );
    expect(s.evidenceMissing).toEqual(expect.arrayContaining(["transaction date", "counterparty"]));
    expect(s.evidencePresent).toEqual(["amount"]);
  });
});
