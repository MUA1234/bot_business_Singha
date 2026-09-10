import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient, supabaseRpcClient } from "@/lib/supabase/read";
import { Icon } from "@/components/Icon";
import { decGtZero, decSub, decSum, fmtMoney } from "@/lib/money";
import { ageItems, type AgingItem } from "@/modules/finance/aging";
import { computeCashPosition, type CashAccount, type CashMovement } from "@/modules/finance/cash-position";
import { BarChart, agingBars } from "@/components/charts";
import { fmtNumber } from "@/lib/format";
import {
  Facts,
  Matter,
  PageHead,
  Section,
  Signal,
  StateNote,
} from "@/components/os/primitives";

export const metadata = { title: "Finance — Singha Central" };

/** Read-only query that never throws (missing table → []). */
async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

/**
 * The finance sub-ledgers, grouped the way a finance person thinks about them
 * rather than alphabetically. Every route here already existed in the finance
 * navigation; grouping them on the overview makes the whole module reachable
 * from its front door instead of only from the rail.
 */
const LEDGER_INDEX: { group: string; items: { href: string; label: string; icon: string; note: string }[] }[] = [
  {
    group: "The ledger",
    items: [
      { href: "/app/finance/chart-of-accounts", label: "Chart of accounts", icon: "clipboard", note: "The account tree everything posts to" },
      { href: "/app/finance/journals", label: "Journals", icon: "file-text", note: "Entries, lines and controlled reversals" },
      { href: "/app/finance/periods", label: "Periods", icon: "check-circle", note: "Open, close and lock accounting periods" },
      { href: "/app/finance/tax-codes", label: "Tax codes", icon: "clipboard", note: "Rates applied to lines" },
    ],
  },
  {
    group: "Money in and out",
    items: [
      { href: "/app/finance/customer-invoices", label: "Customer invoices", icon: "receipt", note: "Raised, settled and outstanding" },
      { href: "/app/finance/supplier-bills", label: "Supplier bills", icon: "receipt", note: "What suppliers have billed" },
      { href: "/app/finance/expenses", label: "Expense claims", icon: "wallet", note: "Staff claims and reimbursements" },
      { href: "/app/finance/receivables", label: "Receivables & payables", icon: "banknote", note: "Ageing on both sides" },
      { href: "/app/finance/commitments", label: "Commitments", icon: "clipboard", note: "Money promised but not yet spent" },
      { href: "/app/finance/loans", label: "Loans", icon: "landmark", note: "Facilities, drawdowns and repayments" },
    ],
  },
  {
    group: "Cash and control",
    items: [
      { href: "/app/finance/accounts", label: "Bank & cash", icon: "landmark", note: "Accounts and their balances" },
      { href: "/app/finance/reconciliation", label: "Reconciliation", icon: "git-branch", note: "Match bank lines to records" },
      { href: "/app/finance/cash-counts", label: "Cash counts", icon: "check-circle", note: "Physical counts against the book" },
      { href: "/app/finance/approvals", label: "Approvals", icon: "gavel", note: "Decisions waiting on an authority" },
      { href: "/app/finance/duplicate-reviews", label: "Duplicate reviews", icon: "eye", note: "Payments paused pending a human decision" },
      { href: "/app/finance/supplier-bank-changes", label: "Supplier bank changes", icon: "shield-alert", note: "Bank-detail changes needing verification" },
    ],
  },
  {
    group: "Planning and reporting",
    items: [
      { href: "/app/finance/budgets", label: "Budgets vs actual", icon: "pie-chart", note: "Budgets against journal activity" },
      { href: "/app/finance/forecast", label: "Cash forecast", icon: "trending-up", note: "Projected position over 90 days" },
      { href: "/app/finance/funding", label: "Funding & investments", icon: "target", note: "Funding gap and the investment register" },
      { href: "/app/finance/trial-balance", label: "Trial balance", icon: "table", note: "Debits and credits by account" },
      { href: "/app/finance/pnl", label: "Profit & loss", icon: "table", note: "Income against expenditure" },
      { href: "/app/finance/balance-sheet", label: "Balance sheet", icon: "table", note: "Assets, liabilities and equity" },
      { href: "/app/finance/exports", label: "Excel exports", icon: "download", note: "Download logs as Excel-compatible CSV" },
    ],
  },
];

export default async function FinanceHome() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [{ data: sent }, { count: openPrice }, invoices, bills, banks, cashes, pmts] = await Promise.all([
    db.from("quotations").select("total, currency, status").eq("company_id", p.companyId).eq("status", "sent"),
    db.from("price_confirmations").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "open"),
    safe<any>(() =>
      db
        .from("customer_invoices")
        .select("currency, total_amount, amount_settled, due_date, status")
        .eq("company_id", p.companyId)
        .not("status", "in", "(paid,cancelled)") as any,
    ),
    safe<any>(() =>
      db
        .from("supplier_bills")
        .select("currency, total_amount, amount_settled, due_date, status")
        .eq("company_id", p.companyId)
        .not("status", "in", "(paid,cancelled)") as any,
    ),
    safe<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("cash_accounts").select("id, name, currency, opening_balance").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("payments").select("direction, amount, bank_account_id, cash_account_id, status").eq("company_id", p.companyId).neq("status", "void") as any),
  ]);

  // OF-016: paused payments are backlog. A suspected duplicate has no approval request, so
  // without this tile it is invisible everywhere a person actually looks. Counted through the
  // capability-gated queue, so a member without `finance.duplicate.resolve` simply sees 0 rather
  // than a number they cannot act on.
  let pausedDuplicates = 0;
  let duplicatesUnavailable = false;
  try {
    const { data, error } = await supabaseRpcClient().rpc("duplicate_review_queue", {
      p_company: p.companyId,
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
  const quotedValue = decSum((sent ?? []).map((q: any) => q.total));

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

  const cashAccounts: CashAccount[] = [...banks, ...cashes].map((a: any) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    openingBalance: String(a.opening_balance ?? 0),
  }));
  const movements: CashMovement[] = pmts
    .map((pm: any): CashMovement | null => {
      const accountId = pm.bank_account_id ?? pm.cash_account_id;
      if (!accountId) return null;
      return { accountId, direction: pm.direction === "in" ? "in" : "out", amount: String(pm.amount ?? 0) };
    })
    .filter((m: CashMovement | null): m is CashMovement => m !== null);
  const cash = computeCashPosition(cashAccounts, movements);
  const cashTotal = cash.totalsByCurrency[currency] ?? "0";

  // ── Exceptions: the things a finance person must act on, not browse. ────
  const exceptions: {
    key: string;
    kind: string;
    icon: string;
    title: string;
    value?: string;
    tone: "critical" | "warn";
    href: string;
    note: string;
  }[] = [];

  if (decGtZero(ap.overdue)) {
    exceptions.push({
      key: "ap",
      kind: "Payables overdue",
      icon: "banknote",
      title: "Bills past their due date",
      value: fmt(ap.overdue),
      tone: "critical",
      href: "/app/finance/receivables",
      note: "Each needs a payment decision from someone holding finance authority.",
    });
  }
  if (decGtZero(ar.overdue)) {
    exceptions.push({
      key: "ar",
      kind: "Receivables overdue",
      icon: "receipt",
      title: "Money owed to the business, past due",
      value: fmt(ar.overdue),
      tone: "warn",
      href: "/app/finance/receivables",
      note: `Oldest bucket (90+ days): ${fmt(ar.buckets.d90_plus)}.`,
    });
  }
  if (!duplicatesUnavailable && pausedDuplicates > 0) {
    exceptions.push({
      key: "dup",
      kind: "Paused",
      icon: "eye",
      title: `${pausedDuplicates} payment${pausedDuplicates === 1 ? "" : "s"} paused as suspected duplicate${pausedDuplicates === 1 ? "" : "s"}`,
      tone: "critical",
      href: "/app/finance/duplicate-reviews",
      note: "A suspected duplicate has no approval request until a person decides, so it appears nowhere else.",
    });
  }
  if ((openPrice ?? 0) > 0) {
    exceptions.push({
      key: "price",
      kind: "Awaiting a human",
      icon: "help-circle",
      title: `${openPrice} price confirmation${openPrice === 1 ? "" : "s"} open`,
      tone: "warn",
      href: "/app/finance/price-requests",
      note: "A quotation cannot be sent until each of these is priced by a person.",
    });
  }

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Finance"
        title="Financial control room"
        lede="Position, obligations and exceptions, from the internally-owned double-entry accounting core. Recording a payment here is not making one — this system does not move money."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/finance/approvals">Approvals</Link>
            <Link className="btn ghost sm" href="/app/finance/forecast">Forecast</Link>
          </>
        }
      />

      {duplicatesUnavailable && (
        <StateNote kind="partial" title="The duplicate-pause queue could not be read">
          This screen cannot say whether any payments are paused as suspected duplicates. That is not
          a statement that there are none.
        </StateNote>
      )}

      {/* ── POSITION ────────────────────────────────────────────────────── */}
      <Section title="Position" meta="cash · receivables · payables" />
      <div className="grid cols-3">
        <Link href="/app/finance/accounts" className="card stat">
          <div className="k">Cash on hand</div>
          <div className="v">{fmt(cashTotal)}</div>
          <div className="d">
            {cash.accounts.length === 0
              ? "No bank or cash accounts recorded"
              : `${fmtNumber(cash.accounts.length)} account(s)`}
          </div>
        </Link>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Receivables outstanding</div>
          <div className="v">{fmt(ar.total)}</div>
          <div className="d">
            {decGtZero(ar.overdue) ? (
              <Signal kind="warn">Overdue {fmt(ar.overdue)}</Signal>
            ) : (
              <Signal kind="ok">None overdue</Signal>
            )}
          </div>
        </Link>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Payables outstanding</div>
          <div className="v">{fmt(ap.total)}</div>
          <div className="d">
            {decGtZero(ap.overdue) ? (
              <Signal kind="critical">Overdue {fmt(ap.overdue)}</Signal>
            ) : (
              <Signal kind="ok">None overdue</Signal>
            )}
          </div>
        </Link>
      </div>

      {/* ── EXCEPTIONS ──────────────────────────────────────────────────── */}
      <Section title="Needs a decision" meta={`${exceptions.length} open`} />
      {exceptions.length === 0 ? (
        <StateNote kind="empty" title="Nothing is waiting on a finance decision">
          No overdue balances, no paused payments and no open price confirmations in the sources
          checked.
          {duplicatesUnavailable && " Note the warning above — the duplicate queue could not be read."}
        </StateNote>
      ) : (
        <div className="field-matters">
          {exceptions.map((e) => (
            <Matter
              key={e.key}
              kind={e.kind}
              kindIcon={e.icon}
              band={e.tone === "critical" ? "critical" : "high"}
              title={e.title}
              value={e.value}
              valueTone={e.tone}
              href={e.href}
              footer={
                <Signal kind={e.tone}>{e.tone === "critical" ? "Act now" : "Decide today"}</Signal>
              }
            />
          ))}
        </div>
      )}

      {/* ── AGEING ──────────────────────────────────────────────────────── */}
      <Section title="Receivables vs payables" meta="by age" />
      <div className="card">
        <p className="small dim" style={{ marginBottom: "var(--sp-3)" }}>
          Chase the amber and red receivable buckets first — the oldest debt is the hardest to
          collect.
        </p>
        <div className="t-label" style={{ marginBottom: 4 }}>Receivables — owed to you</div>
        <BarChart data={agingBars(ar.buckets, fmt)} height={120} />
        <div className="t-label" style={{ marginTop: "var(--sp-4)", marginBottom: 4 }}>
          Payables — you owe
        </div>
        <BarChart data={agingBars(ap.buckets, fmt)} height={120} />
      </div>

      {/* ── PIPELINE ────────────────────────────────────────────────────── */}
      <Section title="Quotation pipeline" meta="sent, not yet decided" />
      <div className="card">
        <Facts
          items={[
            { k: "Quoted value (sent)", v: fmtMoney(quotedValue, currency), numeric: true },
            { k: "Sent quotations", v: fmtNumber(sent?.length ?? 0), numeric: true },
            { k: "Open price confirmations", v: fmtNumber(openPrice ?? 0), numeric: true },
            {
              k: "Paused — suspected duplicates",
              v: duplicatesUnavailable ? "unknown — queue unreadable" : fmtNumber(pausedDuplicates),
              numeric: !duplicatesUnavailable,
            },
          ]}
        />
        <div className="card-footer">
          <Link className="btn ghost sm" href="/app/finance/invoices">Open quotations</Link>
          <Link className="btn ghost sm" href="/app/finance/price-requests">Price confirmations</Link>
        </div>
      </div>

      {/* ── THE WHOLE MODULE, REACHABLE FROM ITS FRONT DOOR ─────────────── */}
      {LEDGER_INDEX.map((group) => (
        <div key={group.group}>
          <Section title={group.group} />
          <div className="grid cols-3">
            {group.items.map((item) => (
              <Link key={item.href} href={item.href} className="node-card">
                <span className="node-card-ico" aria-hidden="true">
                  <Icon name={item.icon} size={17} strokeWidth={1.6} />
                </span>
                <span className="node-card-text">
                  <span className="node-card-title">{item.label}</span>
                  <span className="node-card-note">{item.note}</span>
                </span>
                <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
