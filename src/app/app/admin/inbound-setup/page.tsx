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
import { supabaseReadClient, supabaseRpcClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PermissionDenied } from "@/components/ui/PermissionDenied";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
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
      <PermissionDenied title="Inbound setup" actionHref="/app/admin">
        You do not have permission to change inbound configuration in this company.
      </PermissionDenied>
    );
  }

  const dbRead = supabaseReadClient();
  let accounts: AccountRow[] = [];
  let people: PersonRow[] = [];
  let reviewers = new Set<string>();
  let status: Record<string, unknown> | null = null;
  let loadError: string | null = null;

  try {
    const { data: acc, error: accErr } = await dbRead
      .from("channel_accounts")
      .select("id, channel, provider_account_id, display_label, is_active")
      .eq("company_id", membership.companyId)
      .order("channel");
    if (accErr) throw new Error(accErr.message);
    accounts = (acc ?? []) as AccountRow[];

    const { data: st, error: stErr } = await supabaseRpcClient().rpc("inbound_setup_status", { p_company: membership.companyId });
    if (stErr) throw new Error(stErr.message);
    status = (Array.isArray(st) ? st[0] : st) as Record<string, unknown> | null;

    const { data: profiles, error: pErr } = await dbRead
      .from("profiles")
      .select("id, full_name, username")
      .eq("company_id", membership.companyId)
      .eq("is_active", true)
      .limit(200);
    if (pErr) throw new Error(pErr.message);
    people = (profiles ?? []) as PersonRow[];

    const { data: revs, error: rErr } = await supabaseRpcClient().rpc("inbound_reviewer_user_ids", {
      p_company: membership.companyId,
    });
    if (rErr) throw new Error(rErr.message);
    reviewers = new Set(
      ((revs ?? []) as { user_id: string }[]).map((r) => r.user_id).filter(Boolean),
    );
  } catch (e) {
    loadError = (e as Error).message;
  }

  const activeWhatsapp = accounts.filter((a) => a.channel === "whatsapp" && a.is_active).length;
  const bridgeInUse = status?.single_tenant_bridge_in_use === true;
  const unavailable = loadError !== null;

  const accountColumns: DataTableColumn<AccountRow>[] = [
    { key: "channel", header: "Channel", render: (a) => <Badge>{a.channel}</Badge> },
    { key: "account", header: "Account", render: (a) => <code className="small">{a.provider_account_id}</code> },
    { key: "label", header: "Label", render: (a) => <span className="muted small">{a.display_label ?? "—"}</span> },
    { key: "state", header: "State", render: (a) => <StatusBadge status={a.is_active ? "active" : "inactive"} /> },
    { key: "actions", header: "", render: (a) => <ActivateForm id={a.id} active={a.is_active} /> },
  ];

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
          <strong>This screen could not read the setup.</strong> Nothing is lost — inbound messages
          are still persisted — but the numbers and lists below are NOT being shown, because showing
          zeros would state as fact something this page has not established.
          <div className="muted small mt-1">The database reported: {loadError}</div>
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
          <Card className="stat" padding="sm">
            <div className="k">Active mappings</div>
            <div className="v">{String(status?.active_accounts ?? 0)}</div>
          </Card>
          <Card className="stat" padding="sm">
            <div className="k">People who can review</div>
            <div className="v">{String(status?.reviewers ?? 0)}</div>
          </Card>
          <Card className="stat" padding="sm">
            <div className="k">Open review items</div>
            <div className="v">{String(status?.open_reviews ?? 0)}</div>
          </Card>
        </div>
      )}

      {canConfigure && (
        <Card>
          <CardHeader title="Receiving accounts" />
          <CardBody>
            {accounts.length === 0 ? (
              <EmptyState
                title="No receiving accounts mapped yet"
                description="Add the WhatsApp phone number ID or email/SMS account that receives inbound messages for this company."
              />
            ) : (
              <DataTable
                columns={accountColumns}
                rows={accounts}
                keyExtractor={(a) => a.id}
              />
            )}
            <div className="mt-3">
              <AddAccountForm />
            </div>
          </CardBody>
        </Card>
      )}

      {canGrant && (
        <Card>
          <CardHeader
            title="Who can work the inbound review queue"
            subtitle="The queue holds untrusted third-party message text, so it is capability-gated rather than open to every member. Nobody is granted anything automatically, and you cannot grant it to yourself here."
          />
          <CardBody>
            <div className="stack gap-2">
              {people.map((p) => (
                <ReviewerForm
                  key={p.id}
                  userId={p.id}
                  name={p.full_name ?? p.username ?? p.id}
                  hasRole={reviewers.has(p.id)}
                />
              ))}
              {people.length === 0 && (
                <EmptyState
                  title="No active people in this company"
                  description="Create staff profiles first, then return here to grant inbound-review access."
                />
              )}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
