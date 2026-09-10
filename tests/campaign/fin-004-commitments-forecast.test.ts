/**
 * FIN-004 — Commitments and expected payments.
 *
 * Purchase orders and contractual commitments feed expected outflows alongside
 * invoices/bills in the rolling cash forecast.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { projectCash } from "@/management/ai-manager/forecast";
import { buildCommitmentOutflows } from "@/modules/finance/commitment-outflows";

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("FIN-004 — commitments feed expected outflows", () => {
  const helper = readFileSync("src/modules/finance/commitment-outflows.ts", "utf8");
  const command = readFileSync("src/app/app/command/page.tsx", "utf8");
  const poList = readFileSync("src/app/app/procurement/purchase-orders/page.tsx", "utf8");
  const poDetail = readFileSync("src/app/app/procurement/purchase-orders/[id]/page.tsx", "utf8");
  const actions = readFileSync("src/app/app/procurement/purchase-orders/actions.ts", "utf8");

  it("exports a pure buildCommitmentOutflows helper", () => {
    expect(helper).toContain("export interface CommitmentOutflow");
    expect(helper).toContain("export function buildCommitmentOutflows");
  });

  it("includes an open purchase order with expected_payment_date", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [{ id: "po-1", po_number: "PO-001", total_amount: "12000.00", currency: "LKR", status: "sent", expected_payment_date: iso(10) }],
      commitments: [],
      currency: "LKR",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("purchase_order");
    expect(out[0]!.amount).toBe("12000.00");
    expect(out[0]!.date).toBe(iso(10));
  });

  it("excludes closed and cancelled purchase orders", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [
        { id: "po-closed", po_number: "PO-C", total_amount: "5000.00", currency: "LKR", status: "closed", expected_payment_date: iso(5) },
        { id: "po-cancelled", po_number: "PO-X", total_amount: "5000.00", currency: "LKR", status: "cancelled", expected_payment_date: iso(5) },
      ],
      commitments: [],
      currency: "LKR",
    });
    expect(out).toHaveLength(0);
  });

  it("excludes purchase orders with expected_payment_date outside the horizon", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [{ id: "po-far", po_number: "PO-FAR", total_amount: "5000.00", currency: "LKR", status: "sent", expected_payment_date: iso(120) }],
      commitments: [],
      currency: "LKR",
      horizonDays: 90,
    });
    expect(out).toHaveLength(0);
  });

  it("includes an open commitment with expected_settlement_date", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [],
      commitments: [{ id: "cm-1", description: "Rent", amount: "25000.00", currency: "LKR", status: "open", expected_settlement_date: iso(15) }],
      currency: "LKR",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("commitment");
    expect(out[0]!.amount).toBe("25000.00");
    expect(out[0]!.date).toBe(iso(15));
  });

  it("excludes settled and cancelled commitments", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [],
      commitments: [
        { id: "cm-s", description: "Settled", amount: "1000.00", currency: "LKR", status: "settled", expected_settlement_date: iso(5) },
        { id: "cm-x", description: "Cancelled", amount: "1000.00", currency: "LKR", status: "cancelled", expected_settlement_date: iso(5) },
      ],
      currency: "LKR",
    });
    expect(out).toHaveLength(0);
  });

  it("matches currency exactly and does not convert", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [{ id: "po-usd", po_number: "PO-USD", total_amount: "100.00", currency: "USD", status: "sent", expected_payment_date: iso(5) }],
      commitments: [],
      currency: "LKR",
    });
    expect(out).toHaveLength(0);
  });

  it("sorts results by date ascending", () => {
    const out = buildCommitmentOutflows({
      purchaseOrders: [{ id: "po-1", po_number: "PO-001", total_amount: "1000.00", currency: "LKR", status: "sent", expected_payment_date: iso(20) }],
      commitments: [
        { id: "cm-1", description: "A", amount: "1000.00", currency: "LKR", status: "open", expected_settlement_date: iso(5) },
        { id: "cm-2", description: "B", amount: "1000.00", currency: "LKR", status: "partially_settled", expected_settlement_date: iso(10) },
      ],
      currency: "LKR",
    });
    expect(out.map((o) => o.id)).toEqual(["cm-1", "cm-2", "po-1"]);
  });

  it("Command Centre reads purchase_orders and commitments and adds them to forecast outflows", () => {
    expect(command).toContain('from("purchase_orders")');
    expect(command).toContain('from("commitments")');
    expect(command).toContain("buildCommitmentOutflows");
    expect(command).toContain("...commitmentOutflows.map");
    expect(command).toContain("Expected commitments");
  });

  it("PO list and detail surface expected_payment_date and allow updating it", () => {
    expect(poList).toContain("expected_payment_date");
    expect(poDetail).toContain("expected_payment_date");
    expect(poDetail).toContain("updateExpectedPaymentDate");
    expect(actions).toContain("export async function updateExpectedPaymentDate");
  });

  it("forecast engine shows a lower trough when commitment outflows are included", () => {
    const base = projectCash({
      currency: "LKR",
      openingCash: "10000.00",
      inflows: [],
      outflows: [],
      horizonDays: 30,
    });
    const withCommitment = projectCash({
      currency: "LKR",
      openingCash: "10000.00",
      inflows: [],
      outflows: [{ date: iso(5), amount: "8000.00" }],
      horizonDays: 30,
    });
    expect(Number(withCommitment.lowest.balance)).toBeLessThan(Number(base.lowest.balance));
    expect(withCommitment.lowest.balance).toBe("2000.00");
  });
});
