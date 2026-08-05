import { describe, it, expect } from "vitest";
import { describeAction } from "@/lib/audit-format";

describe("audit action labels (change plan §13)", () => {
  it("maps known verbs", () => {
    expect(describeAction("journal.posted")).toBe("Posted journal");
    expect(describeAction("employee.deactivated")).toBe("Deactivated employee");
    expect(describeAction("customer_invoice.created")).toBe("Created customer invoice");
    expect(describeAction("manager.analyzed")).toBe("AI analysed manager");
  });

  it("falls back gracefully for unknown verbs", () => {
    expect(describeAction("widget.frobnicated")).toBe("Frobnicated widget");
    expect(describeAction("standalone")).toBe("Standalone");
  });
});
