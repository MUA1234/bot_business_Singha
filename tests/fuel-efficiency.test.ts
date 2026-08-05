import { describe, it, expect } from "vitest";
import { fuelEfficiency } from "@/modules/fleet/fuel-efficiency";

describe("fuel efficiency (change plan §9.4)", () => {
  it("computes km per litre from readings", () => {
    // 1000 → 1400 = 400 km; second fill 40 L ⇒ 10 km/L
    const r = fuelEfficiency([{ odometer: 1000, litres: 30 }, { odometer: 1400, litres: 40 }]);
    expect(r.distance).toBe(400);
    expect(r.litresUsed).toBe(40);
    expect(r.kmPerLitre).toBe(10);
  });

  it("needs at least two readings", () => {
    expect(fuelEfficiency([{ odometer: 1000, litres: 30 }]).kmPerLitre).toBe(null);
    expect(fuelEfficiency([]).kmPerLitre).toBe(null);
  });

  it("ignores rows missing odometer or litres, sorts by odometer", () => {
    const r = fuelEfficiency([
      { odometer: 2000, litres: 50 },
      { odometer: null, litres: 20 },
      { odometer: 1000, litres: 25 },
    ]);
    expect(r.distance).toBe(1000);
    expect(r.litresUsed).toBe(50);
    expect(r.kmPerLitre).toBe(20);
  });
});
