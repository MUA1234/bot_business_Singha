import { describe, it, expect } from "vitest";
import { computeCashPosition, type CashAccount, type CashMovement } from "@/modules/finance/cash-position";

describe("cash position (change plan §8.5, decimal money §8)", () => {
  const accounts: CashAccount[] = [
    { id: "bank1", name: "Main Bank", currency: "LKR", openingBalance: "10000.00" },
    { id: "petty", name: "Petty Cash", currency: "LKR", openingBalance: "500.00" },
    { id: "usd", name: "USD Account", currency: "USD", openingBalance: "1000.00" },
  ];

  it("applies inflows and outflows exactly", () => {
    const moves: CashMovement[] = [
      { accountId: "bank1", direction: "in", amount: "2500.50" },
      { accountId: "bank1", direction: "out", amount: "1000.00" },
      { accountId: "petty", direction: "out", amount: "120.25" },
    ];
    const pos = computeCashPosition(accounts, moves);
    const bal = (id: string) => pos.accounts.find((a) => a.id === id)?.balance;
    expect(bal("bank1")).toBe("11500.50");
    expect(bal("petty")).toBe("379.75");
    expect(bal("usd")).toBe("1000.00");
  });

  it("totals per currency", () => {
    const pos = computeCashPosition(accounts, []);
    expect(pos.totalsByCurrency.LKR).toBe("10500.00");
    expect(pos.totalsByCurrency.USD).toBe("1000.00");
  });

  it("ignores movements for unknown accounts", () => {
    const pos = computeCashPosition(accounts, [{ accountId: "ghost", direction: "in", amount: "999" }]);
    expect(pos.totalsByCurrency.LKR).toBe("10500.00");
  });
});
