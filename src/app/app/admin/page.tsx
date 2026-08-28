import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Icon } from "@/components/Icon";
import { PageHead, Section, Signal } from "@/components/os/primitives";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Admin — Singha Central" };

async function count(table: string, companyId: string, extra?: (q: any) => any): Promise<number> {
  let q = supabaseReadClient().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  if (extra) q = extra(q);
  const { count } = await q;
  return count ?? 0;
}

export default async function AdminHome() {
  const admin = await requireAdmin();
  const [employees, quotations, openPrice, orders] = await Promise.all([
    count("profiles", admin.companyId),
    count("quotations", admin.companyId),
    count("price_confirmations", admin.companyId, (q) => q.eq("status", "open")),
    count("orders", admin.companyId, (q) => q.eq("status", "new")),
  ]);

  const tiles = [
    { k: "Employees", v: employees, href: "/app/admin/employees", d: "Manage accounts" },
    { k: "New orders", v: orders, href: "/app/sales/orders", d: "From WhatsApp" },
    { k: "Quotations", v: quotations, href: "/app/sales/quotations", d: "All statuses" },
    { k: "Open price confirmations", v: openPrice, href: "/app/sales/price-requests", d: "Need a human price" },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Owner"
        title={`Welcome, ${admin.fullName || admin.username}`}
        lede="Every department, every approval, every record. Start at the Command Centre for what needs attention today; the areas below are for changing how the system is set up."
        actions={
          <>
            <Link className="btn sm" href="/app/command">Command Centre</Link>
            <Link className="btn ghost sm" href="/app/admin/audit">Audit log</Link>
          </>
        }
      />

      <Section title="Position" />
      <div className="grid cols-4">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v">{fmtNumber(t.v)}</div>
            <div className="d">
              {t.k === "Open price confirmations" && t.v > 0 ? (
                <Signal kind="warn">Blocking a quotation</Signal>
              ) : (
                t.d
              )}
            </div>
          </Link>
        ))}
      </div>

      <Section title="Set up the system" meta="who may do what, and what the system knows" />
      <div className="grid cols-3">
        {[
          { href: "/app/admin/employees", label: "Employees", icon: "users", note: "Create logins and assign departments" },
          { href: "/app/admin/departments", label: "Departments", icon: "building-2", note: "Enable or disable department dashboards" },
          { href: "/app/admin/catalog", label: "Products and prices", icon: "tag", note: "The prices the quoting engine uses" },
          { href: "/app/admin/objectives", label: "Objectives", icon: "target", note: "What the business is working towards" },
          { href: "/app/admin/directives", label: "Directives", icon: "megaphone", note: "Management directives with response obligations" },
          { href: "/app/admin/inbound-setup", label: "Inbound setup", icon: "settings", note: "How messages and email enter the system" },
        ].map((item) => (
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

      <Section title="Watch the system" meta="honest state, not a green light" />
      <div className="grid cols-3">
        {[
          { href: "/app/admin/health", label: "System health", icon: "heart-pulse", note: "Integrations, queues, retries and stale data" },
          { href: "/app/admin/outbox", label: "Outbox and dead letters", icon: "send", note: "Outbound delivery status; replay failures" },
          { href: "/app/admin/integrations", label: "Integrations", icon: "plug", note: "Applications, connectors and contracts" },
          { href: "/app/admin/inbound-review", label: "Inbound review", icon: "inbox", note: "Messages held for a human decision" },
          { href: "/app/admin/audit", label: "Audit log", icon: "scroll-text", note: "Event to decision to action to outcome" },
          { href: "/app/admin/model-budgets", label: "Model budgets", icon: "sparkles", note: "AI spend limits and their enforcement" },
        ].map((item) => (
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
  );
}
