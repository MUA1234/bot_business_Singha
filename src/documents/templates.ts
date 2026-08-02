/**
 * Document generation from OWN templates — the free replacement for a paid
 * accounting product's invoicing. Guide §2 rule 6 (Google Sheets/Excel is a view
 * / import-export surface, never the ledger) + the owner's requirement: render
 * invoices/statements from our own templates and export logs to Excel/CSV, at no
 * per-service cost.
 *
 * This module produces:
 *   - `renderInvoiceHtml`  → a self-contained HTML invoice from a template + data.
 *     HTML is chosen because it renders to PDF for free (headless browser / the
 *     browser's own "Save as PDF"), needs no paid API, and is easy to restyle.
 *   - `toCsv`              → Excel-compatible CSV for ledgers/logs/exports.
 *
 * The numbers come from the Accounting Core (source of truth); templates only
 * present them. Nothing here posts or mutates ledger state.
 */
import { Money } from "@/lib/money";

export interface InvoiceParty {
  name: string;
  address?: string;
  email?: string;
  taxId?: string;
}

export interface InvoiceLine {
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string; // canonical decimal string in `currency`
}

export interface InvoiceData {
  companyName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string;
  currency: string;
  from: InvoiceParty;
  to: InvoiceParty;
  lines: InvoiceLine[];
  taxAmount?: string;
  notes?: string;
  /** Optional brand overrides so each company keeps its own template look. */
  theme?: { accent?: string; logoDataUri?: string };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function money(value: string, currency: string): string {
  return `${currency} ${Money.of(value, currency).toString()}`;
}

/** Compute the invoice total from lines + optional tax (fixed-precision). */
export function invoiceTotal(data: InvoiceData): Money {
  const currency = data.currency;
  let total = Money.zero(currency);
  for (const l of data.lines) total = total.plus(Money.of(l.amount, currency));
  if (data.taxAmount) total = total.plus(Money.of(data.taxAmount, currency));
  return total.round();
}

/**
 * Render a self-contained (no external assets) HTML invoice. Print to PDF with a
 * headless browser at generation time or let the user "Save as PDF" — both free.
 */
export function renderInvoiceHtml(data: InvoiceData): string {
  const accent = data.theme?.accent ?? "#1f2937";
  const logo = data.theme?.logoDataUri
    ? `<img src="${esc(data.theme.logoDataUri)}" alt="logo" style="max-height:56px" />`
    : `<div style="font-size:20px;font-weight:700;color:${accent}">${esc(data.companyName)}</div>`;

  const rows = data.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.description)}</td>
        <td class="num">${esc(l.quantity)}</td>
        <td class="num">${esc(money(l.unitPrice, data.currency))}</td>
        <td class="num">${esc(money(l.amount, data.currency))}</td>
      </tr>`,
    )
    .join("\n");

  const taxRow = data.taxAmount
    ? `<tr><td colspan="3" class="num label">Tax</td><td class="num">${esc(money(data.taxAmount, data.currency))}</td></tr>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Invoice ${esc(data.invoiceNumber)}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;margin:0;padding:32px;}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${accent};padding-bottom:16px;}
  h1{font-size:24px;margin:0;color:${accent};letter-spacing:.5px}
  .meta{font-size:13px;color:#444;text-align:right}
  .parties{display:flex;gap:48px;margin:24px 0}
  .parties h3{font-size:11px;text-transform:uppercase;color:#888;margin:0 0 6px}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}
  th{ text-align:left;background:${accent};color:#fff;padding:8px 10px;font-size:12px}
  td{padding:8px 10px;border-bottom:1px solid #eee}
  .num{text-align:right}
  .label{font-weight:600;color:#555}
  tfoot td{border:none;font-size:15px}
  .total td{font-weight:700;border-top:2px solid ${accent};color:${accent}}
  .notes{margin-top:28px;font-size:12px;color:#666;white-space:pre-wrap}
</style></head>
<body>
  <div class="head">
    <div>${logo}</div>
    <div class="meta">
      <h1>INVOICE</h1>
      <div># ${esc(data.invoiceNumber)}</div>
      <div>Issued: ${esc(data.issueDate)}</div>
      ${data.dueDate ? `<div>Due: ${esc(data.dueDate)}</div>` : ""}
    </div>
  </div>
  <div class="parties">
    <div><h3>From</h3>${esc(data.from.name)}<br/>${esc(data.from.address ?? "")}</div>
    <div><h3>Bill to</h3>${esc(data.to.name)}<br/>${esc(data.to.address ?? "")}</div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      ${taxRow}
      <tr class="total"><td colspan="3" class="num label">Total</td><td class="num">${esc(money(invoiceTotal(data).toString(), data.currency))}</td></tr>
    </tfoot>
  </table>
  ${data.notes ? `<div class="notes">${esc(data.notes)}</div>` : ""}
</body></html>`;
}

/**
 * Excel-compatible CSV. Values with commas/quotes/newlines are quoted; a UTF-8 BOM
 * is prepended so Excel opens accents correctly. This is the "save logs in Excel"
 * export surface (guide §2 rule 6).
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))];
  return "﻿" + lines.join("\r\n");
}
