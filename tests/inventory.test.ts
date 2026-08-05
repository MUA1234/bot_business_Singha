import { describe, it, expect } from "vitest";
import { needsReorder, reorderList, stockValuation, type StockItem } from "@/modules/procurement/inventory";

describe("inventory (change plan §9.2)", () => {
  const items: StockItem[] = [
    { name: "Bolts", quantityOnHand: 5, reorderLevel: 10, unitCost: "2.50" },
    { name: "Nuts", quantityOnHand: 100, reorderLevel: 20, unitCost: "1.00" },
    { name: "Washers", quantityOnHand: 0, reorderLevel: 0, unitCost: "0.50" },
  ];

  it("flags items at/below reorder level", () => {
    expect(needsReorder({ quantityOnHand: 5, reorderLevel: 10 })).toBe(true);
    expect(needsReorder({ quantityOnHand: 10, reorderLevel: 10 })).toBe(true);
    expect(needsReorder({ quantityOnHand: 11, reorderLevel: 10 })).toBe(false);
    expect(needsReorder({ quantityOnHand: 0, reorderLevel: 0 })).toBe(false); // no level set
  });

  it("lists only items needing reorder", () => {
    expect(reorderList(items).map((i) => i.name)).toEqual(["Bolts"]);
  });

  it("values stock with exact decimals", () => {
    // 5*2.50 + 100*1.00 = 112.50
    expect(stockValuation(items, "LKR")).toBe("112.50");
  });
});
