import { describe, it, expect } from "vitest";
import { suggestMatches, type BankTxn, type ReconCandidate } from "@/modules/finance/reconcile";

describe("bank reconciliation matcher (change plan §8.3)", () => {
  const txns: BankTxn[] = [
    { id: "t1", date: "2026-08-05", amount: "-1500.00", currency: "LKR" },
    { id: "t2", date: "2026-08-05", amount: "2000.00", currency: "LKR" },
    { id: "t3", date: "2026-08-05", amount: "9999.00", currency: "LKR" },
  ];
  const cands: ReconCandidate[] = [
    { id: "p1", kind: "payment", date: "2026-08-05", amount: "1500.00", currency: "LKR" },
    { id: "r1", kind: "receipt", date: "2026-08-07", amount: "2000.00", currency: "LKR" },
  ];

  it("matches equal absolute amount, nearest date", () => {
    const s = suggestMatches(txns, cands, 5);
    const by = (id: string) => s.find((x) => x.bankTxnId === id)!;
    expect(by("t1").candidateId).toBe("p1");
    expect(by("t1").confidence).toBe("high"); // same day
    expect(by("t2").candidateId).toBe("r1");
    expect(by("t2").confidence).toBe("medium"); // 2 days
    expect(by("t3").candidateId).toBe(null); // no candidate
  });

  it("uses a candidate at most once", () => {
    const dupTxns: BankTxn[] = [
      { id: "a", date: "2026-08-05", amount: "1500.00", currency: "LKR" },
      { id: "b", date: "2026-08-05", amount: "1500.00", currency: "LKR" },
    ];
    const s = suggestMatches(dupTxns, [cands[0]!], 5);
    const matched = s.filter((x) => x.candidateId === "p1");
    expect(matched).toHaveLength(1);
  });

  it("respects currency and the day window", () => {
    const s = suggestMatches(
      [{ id: "x", date: "2026-08-05", amount: "1500.00", currency: "USD" }],
      [{ id: "p1", kind: "payment", date: "2026-08-05", amount: "1500.00", currency: "LKR" }],
      5,
    );
    expect(s[0]?.candidateId).toBe(null);
  });
});
