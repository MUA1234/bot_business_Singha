/**
 * Inbound setup (R1 §5, OF-004 / OF-005).
 *
 * Two things previously required editing the database by hand: mapping a receiving number to its
 * company, and giving someone the capability to work the inbound review queue. Both are
 * security-relevant, and neither had a surface, a validation step or an audit trail.
 *
 * This screen says "configuration required" until it is configured, and it never grants anything by
 * itself: a mapping is created inactive, activation is an explicit act, and a role is granted only
 * by someone who already holds `admin.identity.manage`.
 */
import { requireMembership, membershipHasCapability } from "@/lib/access";
import { supabaseAdmin } from "@/lib/supabase/server";
import { AddAccountForm, ActivateForm, ReviewerForm } from "./SetupForms";

export const metadata = { title: "Inbound setup — Singha Central" };

interface AccountRow { id: string; channel: string; provider_account_id: string; display_label: string | null; is_active: boolean }
interface PersonRow { id: string; full_name: string | null; username: string | null }

export default async function InboundSetupPage() {
  const membership = await requireMembership();
  const canConfigure = await membershipHasCapability(membership, "admin.organisation.manage");
  const canGrant = await membershipHasCapability(membership, "admin.identity.manage");

  if (!canConfigure && !canGrant) {
    return (
      <div className="stack gap-3">
        <h1>Inbound setup</h1>
        <div className="notice err">
          You do not have permission to change inbound configuration in this company.
        </div>
      </div>
    );
  }

  const db = supabaseAdmin();
  let accounts: AccountRow[] = [];
  let people: PersonRow[] = [];
  let reviewers = new Set<string>();
  let status: Record<string, unknown> | null = null;
  let unavailable = false;

  try {
    const { data: acc, error: accErr } = await db
      .from("channel_accounts")
      .select("id, channel, provider_account_id, display_label, is_active")
      .eq("company_id", membership.companyId)
      .order("channel");
    if (accErr) throw new Error(accErr.message);
    accounts = (acc ?? []) as AccountRow[];

    const { data: st } = await db.rpc("inbound_setup_status", { p_company: membership.companyId });
    status = (Array.isArray(st) ? st[0] : st) as Record<string, unknown> | null;

    const { data: profiles } = await db
      .from("profiles")
      .select("id, full_name, username")
      .eq("company_id", membership.companyId)
      .eq("is_active", true)
      .limit(200);
    people = (profiles ?? []) as PersonRow[];

    const { data: roles } = await db
      .from("membership_roles")
      .select("role_key, memberships!inner(user_id, company_id, status)")
      .eq("company_id", membership.companyId);
    // The embedded relation comes back as an array or an object depending on the client's shape
    // inference; normalise rather than assert, so a shape change fails visibly instead of silently.
    reviewers = new Set(
      ((roles ?? []) as unknown as { role_key: string; memberships: unknown }[])
        .filter((r) => ["finance_reviewer", "owner_management", "system_administrator"].includes(r.role_key))
        .flatMap((r) => {
          const m = r.memberships as { user_id?: string } | { user_id?: string }[] | null;
          const rows = Array.isArray(m) ? m : m ? [m] : [];
          return rows.map((x) => x.user_id ?? "").filter(Boolean);
        }),
    );
  } catch {
    unavailable = true;
  }

  const activeWhatsapp = accounts.filter((a) => a.channel === "whatsapp" && a.is_active).length;
  const bridgeInUse = status?.single_tenant_bridge_in_use === true;

  return (
    <div className="stack gap-3">
      <div>
        <h1>Inbound setup</h1>
        <p className="muted mt-1">
          Which company owns the messages arriving on each number, and who may work the review queue.
        </p>
      </div>

      {unavailable && (
        <div className="notice err">
          The configuration tables are not present in this database yet. Nothing is lost — inbound
          messages are still persisted — but this screen cannot show or change the setup.
        </div>
      )}

      {!unavailable && activeWhatsapp === 0 && (
        <div className="notice err">
          <strong>Configuration required.</strong> No WhatsApp number is mapped to this company.
          {bridgeInUse
            ? " While exactly one company exists, messages are attributed by the documented single-tenant bridge — which stops working the moment a second company is created."
            : " Messages arriving on an unmapped number are persisted and reported, but not processed."}
        </div>
      )}

      {!unavailable && Number(status?.conflicting_accounts ?? 0) > 0 && (
        <div className="notice err">
          ⚠️ {String(status?.conflicting_accounts)} of your mappings name an account that another
          company also has active. Deciding who owns it is your call — this screen will not take it over.
        </div>
      )}

      {!unavailable && (
        <div className="grid cols-3">
          <div className="card stat"><div className="k">Active mappings</div><div className="v">{String(status?.active_accounts ?? 0)}</div></div>
          <div className="card stat"><div className="k">People who can review</div><div className="v">{String(status?.reviewers ?? 0)}</div></div>
          <div className="card stat"><div className="k">Open review items</div><div className="v">{String(status?.open_reviews ?? 0)}</div></div>
        </div>
      )}

      {canConfigure && (
        <div className="card">
          <div className="card-title">Receiving accounts</div>
          {accounts.length === 0 && <p className="muted small mt-2">None mapped yet.</p>}
          {accounts.length > 0 && (
            <table className="table mt-2">
              <thead><tr><th>Channel</th><th>Account</th><th>Label</th><th>State</th><th /></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.channel}</td>
                    <td><code className="small">{a.provider_account_id}</code></td>
                    <td className="muted small">{a.display_label ?? "—"}</td>
                    <td>{a.is_active ? "active" : "inactive"}</td>
                    <td><ActivateForm id={a.id} active={a.is_active} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <AddAccountForm />
        </div>
      )}

      {canGrant && (
        <div className="card">
          <div className="card-title">Who can work the inbound review queue</div>
          <p className="muted small mt-1">
            The queue holds untrusted third-party message text, so it is capability-gated rather than
            open to every member. Nobody is granted anything automatically, and you cannot grant it
            to yourself here.
          </p>
          <div className="stack gap-2 mt-2">
            {people.map((p) => (
              <ReviewerForm
                key={p.id}
                userId={p.id}
                name={p.full_name ?? p.username ?? p.id}
                hasRole={reviewers.has(p.id)}
              />
            ))}
            {people.length === 0 && <p className="muted small">No active people in this company yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
