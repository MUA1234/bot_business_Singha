/**
 * Excel-compatible CSV exports for finance/admin (D-012: logs to Excel, free).
 * Auth-gated: only finance or admin of the company. Uses the shared toCsv (UTF-8
 * BOM so Excel opens accents correctly).
 */
import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { toCsv } from "@/documents/templates";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { kind: string } }) {
  const p = await getProfile();
  if (!p) return new NextResponse("Unauthorized", { status: 401 });
  if (!p.isAdmin && p.department !== "finance")
    return new NextResponse("Forbidden", { status: 403 });
  // The audit trail is admin-only.
  if (params.kind === "audit" && !p.isAdmin)
    return new NextResponse("Forbidden", { status: 403 });

  const db = supabaseAdmin();
  let headers: string[] = [];
  let rows: (string | number | null | undefined)[][] = [];

  switch (params.kind) {
    case "quotations": {
      const { data } = await db
        .from("quotations")
        .select("quote_number, currency, subtotal, tax_amount, total, status, created_at, sent_at")
        .eq("company_id", p.companyId)
        .order("created_at", { ascending: false });
      headers = ["Quote number", "Currency", "Subtotal", "Tax", "Total", "Status", "Created", "Sent"];
      rows = (data ?? []).map((q: any) => [
        q.quote_number, q.currency, q.subtotal, q.tax_amount, q.total, q.status, q.created_at, q.sent_at,
      ]);
      break;
    }
    case "orders": {
      const { data } = await db
        .from("orders")
        .select("customer_name, customer_phone, customer_address, customer_email, request_text, status, created_at")
        .eq("company_id", p.companyId)
        .order("created_at", { ascending: false });
      headers = ["Customer", "Phone", "Address", "Email", "Request", "Status", "Created"];
      rows = (data ?? []).map((o: any) => [
        o.customer_name, o.customer_phone, o.customer_address, o.customer_email, o.request_text, o.status, o.created_at,
      ]);
      break;
    }
    case "price-confirmations": {
      const { data } = await db
        .from("price_confirmations")
        .select("description, quantity, currency, resolved_price, department, status, resolved_at, created_at")
        .eq("company_id", p.companyId)
        .order("created_at", { ascending: false });
      headers = ["Item", "Qty", "Currency", "Confirmed price", "Department", "Status", "Resolved", "Created"];
      rows = (data ?? []).map((r: any) => [
        r.description, r.quantity, r.currency, r.resolved_price, r.department, r.status, r.resolved_at, r.created_at,
      ]);
      break;
    }
    case "catalog": {
      const { data } = await db
        .from("product_catalog")
        .select("name, sku, unit_price, currency, is_active, created_at")
        .eq("company_id", p.companyId)
        .order("name");
      headers = ["Product", "SKU", "Unit price", "Currency", "Active", "Created"];
      rows = (data ?? []).map((c: any) => [
        c.name, c.sku, c.unit_price, c.currency, c.is_active ? "yes" : "no", c.created_at,
      ]);
      break;
    }
    case "journals": {
      const { data } = await db
        .from("journal_entries")
        .select("posting_date, currency, memo, status, total_debit, total_credit")
        .eq("company_id", p.companyId)
        .order("posting_date", { ascending: false });
      headers = ["Date", "Currency", "Memo", "Status", "Debit", "Credit"];
      rows = (data ?? []).map((j: any) => [j.posting_date, j.currency, j.memo, j.status, j.total_debit, j.total_credit]);
      break;
    }
    case "audit": {
      const { data } = await db
        .from("audit_events")
        .select("created_at, actor_type, actor_id, action, entity_type, entity_id")
        .eq("company_id", p.companyId)
        .order("created_at", { ascending: false })
        .limit(5000);
      headers = ["When", "Actor type", "Actor", "Action", "Entity type", "Entity id"];
      rows = (data ?? []).map((a: any) => [a.created_at, a.actor_type, a.actor_id, a.action, a.entity_type, a.entity_id]);
      break;
    }
    default:
      return new NextResponse("Unknown export", { status: 404 });
  }

  const csv = toCsv(headers, rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="singha-${params.kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
