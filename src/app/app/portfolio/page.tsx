/**
 * CTL-002 — Cross-company portfolio overview.
 *
 * An owner (admin) who belongs to more than one company sees them together on a
 * single read-only page. Isolation is preserved by loading ONLY companies where the
 * current user has an active membership. The aggregation is deterministic and uses
 * existing pure finance/workforce helpers.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { decSub, fmtMoney } from "@/lib/money";
import { summarizeCompanyPortfolio, rankPortfolioByUrgency, type PortfolioCompanyInput, type PortfolioCompanySummary } from "@/modules/management/portfolio";
import { log } from "@/lib/log";
import { DataTable, EmptyState, Card, Badge, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Portfolio — Singha Central" };

function statusTone(status: PortfolioCompanySummary["status"]): "danger" | "warn" | "ok" {
  if (status === "critical") return "danger";
  if (status === "warn") return "warn";
  return "ok";
}

const columns: DataTableColumn<PortfolioCompanySummary>[] = [
  { key: "company", header: "Company", render: (s) => <strong>{s.name}</strong> },
  { key: "status", header: "Status", render: (s) => <Badge variant={statusTone(s.status)}>{s.status}</Badge> },
  { key: "projects", header: "Projects", align: "right", render: (s) => `${fmtNumber(s.activeProjectCount)}/${fmtNumber(s.projectCount)}` },
  { key: "openTasks", header: "Open tasks", align: "right", render: (s) => fmtNumber(s.openTasks) },
  { key: "overdue", header: "Overdue", align: "right", render: (s) => <span style={{ color: s.overdueTasks > 0 ? "var(--danger)" : undefined }}>{fmtNumber(s.overdueTasks)}</span> },
  { key: "cash", header: "Cash", align: "right", render: (s) => fmtMoney(s.cashOnHand, s.currency) },
  { key: "arOverdue", header: "AR overdue", align: "right", render: (s) => <span style={{ color: s.arOverdue !== "0" ? "var(--danger)" : undefined }}>{fmtMoney(s.arOverdue, s.currency)}</span> },
  { key: "apOverdue", header: "AP overdue", align: "right", render: (s) => fmtMoney(s.apOverdue, s.currency) },
  { key: "risks", header: "Risks", align: "right", render: (s) => fmtNumber(s.openRisks) },
  { key: "incidents", header: "Incidents", align: "right", render: (s) => <span style={{ color: s.openIncidents > 0 ? "var(--danger)" : undefined }}>{fmtNumber(s.openIncidents)}</span> },
  { key: "obligations", header: "Obligations", align: "right", render: (s) => fmtNumber(s.openObligations) },
  { key: "topIssue", header: "Top issue", render: (s) => <span className="small">{s.issues[0]?.message ?? "—"}</span> },
];

export default async function PortfolioPage() {
  const admin = await requireAdmin();
  const db = supabaseReadClient();

  // Load every company this user has an active membership in. No other companies
  // are reachable, so cross-company visibility is strictly bounded by membership.
  const { data: memberships, error: membershipError } = await db
    .from("memberships")
    .select("company_id")
    .eq("user_id", admin.userId)
    .eq("status", "active");

  if (membershipError) {
    log("error", "portfolio membership read failed", { event: "portfolio.membership_read_failed", error: membershipError.message });
    redirect("/app/command");
  }

  const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id))];

  if (companyIds.length === 0) {
    return (
      <div className="stack gap-3">
        <h1>Portfolio</h1>
        <Card>
          <EmptyState
            title="No companies"
            description="No company memberships found. Once you are added to a company, it will appear here."
            icon="building-2"
          />
        </Card>
      </div>
    );
  }

  const { data: companies, error: companyError } = await db
    .from("companies")
    .select("id, name, base_currency")
    .in("id", companyIds);

  if (companyError) {
    log("error", "portfolio company read failed", { event: "portfolio.company_read_failed", error: companyError.message });
    redirect("/app/command");
  }

  const today = new Date().toISOString().slice(0, 10);
  const summaries: ReturnType<typeof summarizeCompanyPortfolio>[] = [];

  for (const company of companies ?? []) {
    const companyId = company.id;
    const currency = company.base_currency || "LKR";

    const [
      projects,
      tasks,
      risks,
      incidents,
      obligations,
      banks,
      cashes,
      payments,
      invoices,
      bills,
      capacityRows,
    ] = await Promise.all([
      db.from("projects").select("status").eq("company_id", companyId),
      db.from("tasks").select("status, due_date").eq("company_id", companyId),
      db.from("risks").select("status").eq("company_id", companyId),
      db.from("incidents").select("status").eq("company_id", companyId),
      db.from("obligations").select("status").eq("company_id", companyId),
      db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", companyId),
      db.from("cash_accounts").select("id, name, currency, opening_balance").eq("company_id", companyId),
      db.from("payments").select("direction, amount, bank_account_id, cash_account_id, status").eq("company_id", companyId).neq("status", "void"),
      db.from("customer_invoices").select("total_amount, amount_settled, due_date, status").eq("company_id", companyId).not("status", "in", "(paid,cancelled)"),
      db.from("supplier_bills").select("total_amount, amount_settled, due_date, status").eq("company_id", companyId).not("status", "in", "(paid,cancelled)"),
      db.from("capacity_snapshots").select("membership_id, status, week_start").eq("company_id", companyId).order("week_start", { ascending: false }),
    ]);

    const cashAccounts = [...(banks?.data ?? []), ...(cashes?.data ?? [])].map((a: any) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      openingBalance: String(a.opening_balance ?? 0),
    }));

    const movements = (payments?.data ?? [])
      .map((p: any) => {
        const accountId = p.bank_account_id ?? p.cash_account_id;
        if (!accountId) return null;
        return { accountId, direction: p.direction === "in" ? ("in" as const) : ("out" as const), amount: String(p.amount ?? 0) };
      })
      .filter((m): m is { accountId: string; direction: "in" | "out"; amount: string } => m !== null);

    const toItems = (rows: any[]) =>
      rows.map((r) => ({ dueDate: r.due_date ?? null, outstanding: decSub(String(r.total_amount ?? 0), String(r.amount_settled ?? 0)).toFixed() }));

    // Latest snapshot per membership only.
    const latestMembershipStatus = new Map<string, string>();
    for (const row of (capacityRows?.data ?? []) as any[]) {
      if (!latestMembershipStatus.has(row.membership_id)) {
        latestMembershipStatus.set(row.membership_id, row.status);
      }
    }

    const input: PortfolioCompanyInput = {
      companyId,
      name: company.name || "Untitled",
      currency,
      projects: (projects?.data ?? []) as PortfolioCompanyInput["projects"],
      tasks: (tasks?.data ?? []) as PortfolioCompanyInput["tasks"],
      risks: (risks?.data ?? []) as PortfolioCompanyInput["risks"],
      incidents: (incidents?.data ?? []) as PortfolioCompanyInput["incidents"],
      obligations: (obligations?.data ?? []) as PortfolioCompanyInput["obligations"],
      cashAccounts,
      payments: movements,
      invoices: toItems(invoices?.data ?? []),
      bills: toItems(bills?.data ?? []),
      capacitySnapshots: [...latestMembershipStatus.values()].map((status) => ({ status })),
    };

    summaries.push(summarizeCompanyPortfolio(input, today));
  }

  const ranked = rankPortfolioByUrgency(summaries);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Portfolio overview</h1>
          <p className="muted mt-1">{ranked.length} compan{ranked.length === 1 ? "y" : "ies"} — ranked by attention needed.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command">← Command Centre</Link>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={ranked}
          keyExtractor={(s) => s.companyId}
          emptyTitle="No company data available"
          emptyDescription="Once portfolio data is loaded it will appear here."
          caption="Portfolio companies ranked by attention needed"
        />
      </Card>
    </div>
  );
}
