import { describe, it, expect } from "vitest";
import { invoiceTotal, renderInvoiceHtml, toCsv, type InvoiceData } from "@/documents/templates";
import { verifyWhatsappSignature } from "@/lib/whatsapp-signature";
import { createHmac } from "node:crypto";

const invoice: InvoiceData = {
  companyName: "Singha Holdings",
  invoiceNumber: "INV-0001",
  issueDate: "2026-07-30",
  currency: "LKR",
  from: { name: "Singha Holdings" },
  to: { name: "ABC Traders" },
  lines: [
    { description: "Consulting", quantity: "2", unitPrice: "10000.00", amount: "20000.00" },
    { description: "Materials", quantity: "1", unitPrice: "5500.00", amount: "5500.00" },
  ],
  taxAmount: "2550.00",
};

describe("Own-template invoice generation (free QuickBooks replacement)", () => {
  it("computes the total with fixed-precision decimals", () => {
    expect(invoiceTotal(invoice).toString()).toBe("28050.00");
  });

  it("renders self-contained HTML with the numbers", () => {
    const html = renderInvoiceHtml(invoice);
    expect(html).toContain("INV-0001");
    expect(html).toContain("LKR 28050.00");
    expect(html).not.toMatch(/https?:\/\//); // no external assets → renders offline / free PDF
  });

  it("escapes HTML to prevent injection from untrusted party names", () => {
    const html = renderInvoiceHtml({ ...invoice, to: { name: "<script>alert(1)</script>" } });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("Excel/CSV export (guide §2 rule 6)", () => {
  it("quotes cells containing commas/quotes and prepends a BOM", () => {
    const csv = toCsv(["date", "memo", "amount"], [["2026-07-30", 'Paid "ABC, Ltd"', "14500.00"]]);
    expect(csv.startsWith("﻿")).toBe(true); // BOM for Excel
    expect(csv).toContain('"Paid ""ABC, Ltd"""');
  });
});

describe("WhatsApp signature (D-007 hard reject)", () => {
  it("accepts a correct signature and rejects a tampered body", () => {
    const secret = "app-secret";
    const body = JSON.stringify({ hello: "world" });
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWhatsappSignature(body, sig, secret)).toBe(true);
    expect(verifyWhatsappSignature(body + "tamper", sig, secret)).toBe(false);
    expect(verifyWhatsappSignature(body, null, secret)).toBe(false);
  });
});
