/**
 * Reusable Finance panel. Used by the full `/app/finance` page and by the
 * spatial workspace. The caller must enforce permission (finance department or admin).
 */
import { supabaseReadClient, supabaseRpcClient } from "@/lib/supabase/read";
import { decSub, decSum, fmtMoney } from "@/lib/money";
import { ageItems, type AgingItem } from "@/modules/finance/aging";
import { agingBars } from "@/components/charts";
import { FinancePanelContent } from "./FinancePanelContent";
import type { PlainObject } from "./FinancePanelContent";

// Backward-compatible alias for existing consumers (e.g. spatial windows).
export const FinanceContent = FinancePanelContent;

/** Read-only query that never throws (missing table → []). */
async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export async function loadFinanceData(
  companyId: string,
  _userId?: string,
): Promise<PlainObject> {
  const db = supabaseReadClient();

  const [{ data: sent }, { count: openPrice }, invoices, bills] = await Promise.all([
    db.from("quotations").select("total, currency, status").eq("company_id", companyId).eq("status", "sent"),
    db.from("price_confirmations").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "open"),
    safe<any>(() =>
      db
        .from("customer_invoices")
        .select("currency, total_amount, amount_settled, due_date, status")
        .eq("company_id", companyId)
        .not("status", "in", "(paid,cancelled)") as any,
    ),
    safe<any>(() =>
      db
        .from("supplier_bills")
        .select("currency, total_amount, amount_settled, due_date, status")
        .eq("company_id", companyId)
        .not("status", "in", "(paid,cancelled)") as any,
    ),
  ]);

  // OF-016: paused payments are backlog. A suspected duplicate has no approval request, so
  // without this tile it is invisible everywhere a person actually looks. Counted through the
  // capability-gated queue, so a member without `finance.duplicate.resolve` simply sees 0 rather
  // than a number they cannot act on.
  let pausedDuplicates = 0;
  let duplicatesUnavailable = false;
  try {
    const { data, error } = await supabaseRpcClient().rpc("duplicate_review_queue", {
      p_company: companyId,
    });
    if (error) duplicatesUnavailable = true;
    else {
      // Count DISTINCT paused PAYMENTS, not review rows. One payment that resembles two earlier
      // ones raises two reviews, and counting rows made the banner say "2 payments are paused"
      // when one was. The label says payments, so the number must mean payments.
      const open = ((data ?? []) as { state: string; candidate_event_id: string }[])
        .filter((r) => r.state === "open");
      pausedDuplicates = new Set(open.map((r) => r.candidate_event_id)).size;
    }
  } catch {
    duplicatesUnavailable = true;
  }

  const currency = sent?.[0]?.currency ?? invoices[0]?.currency ?? "LKR";
  const quotedValue = decSum((sent ?? []).map((q: any) => q.total)).toFixed();

  // Outstanding = total − settled, aged. Decimal strings throughout (Constitution §8).
  const toItems = (rows: any[]): AgingItem[] =>
    rows.map((r) => ({
      dueDate: r.due_date ?? null,
      outstanding: decSub(r.total_amount, r.amount_settled).toFixed(),
    }));
  const now = new Date();
  const ar = ageItems(toItems(invoices), currency, now);
  const ap = ageItems(toItems(bills), currency, now);
  const fmt = (v: string) => fmtMoney(v, currency);

  return {
    currency,
    quotedValue,
    sentCount: sent?.length ?? 0,
    openPrice,
    duplicatesUnavailable,
    pausedDuplicates,
    arTotal: ar.total,
    arOverdue: ar.overdue,
    arD90Plus: ar.buckets.d90_plus,
    apTotal: ap.total,
    apOverdue: ap.overdue,
    apD90Plus: ap.buckets.d90_plus,
    arBars: agingBars(ar.buckets, fmt),
    apBars: agingBars(ap.buckets, fmt),
  };
}

interface FinancePanelProps {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}

export default async function FinancePanel({ companyId, userId, embedded }: FinancePanelProps) {
  const data = await loadFinanceData(companyId, userId);
  return <FinancePanelContent data={data} embedded={embedded ?? false} />;
}
