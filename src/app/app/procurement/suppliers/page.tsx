/**
 * Suppliers — canonical supplier identity (CRM-002).
 *
 * One supplier record per real supplier, with channel identities (WhatsApp, email,
 * etc.) attached and duplicate identities surfaced. Bank-detail changes are a
 * separately approved maker-checker workflow (migration 0045); this page shows
 * current details and flags the control, not the edit form itself.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { counterpartyHealth } from "@/modules/crm/counterparty-compliance";

export const metadata = { title: "Suppliers — Singha Central" };

interface ChannelIdentity {
  channel: string;
  identity: string;
}

interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  status: string;
  compliance_status: string;
  insurance_status: string;
  insurance_expiry: string | null;
  channel_identities: ChannelIdentity[];
}

/** Detect identities claimed by more than one active supplier in the same company. */
function findDuplicateIdentities(suppliers: Supplier[]): Map<string, string[]> {
  const byIdentity = new Map<string, string[]>();
  for (const s of suppliers) {
    if (s.status !== "active") continue;
    for (const ch of s.channel_identities) {
      const key = `${ch.channel}:${ch.identity}`;
      const list = byIdentity.get(key) ?? [];
      if (!list.includes(s.id)) list.push(s.id);
      byIdentity.set(key, list);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [key, ids] of byIdentity) {
    if (ids.length > 1) duplicates.set(key, ids);
  }
  return duplicates;
}

export default async function SuppliersPage() {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const { data: rows } = await db
    .from("suppliers")
    .select("id, name, email, phone, bank_account_name, bank_account_number, status, compliance_status, insurance_status, insurance_expiry")
    .eq("company_id", p.companyId)
    .order("name", { ascending: true })
    .limit(500);

  const supplierIds = (rows ?? []).map((r: any) => r.id);
  const { data: channelRows } = supplierIds.length
    ? await db
        .from("channel_identities")
        .select("actor_id, channel, identity")
        .eq("company_id", p.companyId)
        .eq("actor_type", "supplier")
        .in("actor_id", supplierIds)
    : { data: [] };

  const channelsBySupplier = new Map<string, ChannelIdentity[]>();
  for (const ch of channelRows ?? []) {
    const list = channelsBySupplier.get(ch.actor_id as string) ?? [];
    list.push({ channel: ch.channel as string, identity: ch.identity as string });
    channelsBySupplier.set(ch.actor_id as string, list);
  }

  const suppliers: Supplier[] = (rows ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    bank_account_name: r.bank_account_name,
    bank_account_number: r.bank_account_number,
    status: r.status,
    compliance_status: r.compliance_status ?? "pending",
    insurance_status: r.insurance_status ?? "pending",
    insurance_expiry: r.insurance_expiry ?? null,
    channel_identities: channelsBySupplier.get(r.id) ?? [],
  }));

  const duplicateIdentities = findDuplicateIdentities(suppliers);
  const duplicateSupplierIds = new Set<string>();
  for (const ids of duplicateIdentities.values()) {
    for (const id of ids) duplicateSupplierIds.add(id);
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Suppliers</h1>
          <p className="muted mt-1">Canonical records with channel identities and bank details. Duplicates are flagged; bank changes require approval.</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement">← Procurement</Link>
      </div>

      {duplicateSupplierIds.size > 0 && (
        <div className="notice warn">
          <strong>{duplicateSupplierIds.size}</strong> supplier record{duplicateSupplierIds.size === 1 ? "" : "s"} share a channel identity with another record.
          Review and merge them manually.
        </div>
      )}

      <div className="card">
        <div className="card-title">Canonical suppliers</div>
        {(suppliers ?? []).length === 0 ? (
          <div className="empty mt-2">No suppliers yet.</div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="data">
              <thead>
                <tr><th>Supplier</th><th>Channel identities</th><th>Bank details</th><th>Compliance</th><th>Insurance</th></tr>
              </thead>
              <tbody>
                {suppliers.map((s) => {
                  const isDuplicate = duplicateSupplierIds.has(s.id);
                  const health = counterpartyHealth({
                    status: s.status,
                    compliance_status: s.compliance_status,
                    insurance_status: s.insurance_status,
                    insurance_expiry: s.insurance_expiry,
                  });
                  const healthBadge = health === "verified" ? "ok" : health === "blocked" ? "danger" : "warn";
                  return (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600 }}>
                        {s.name}
                        {isDuplicate && <span className="badge warn ml-1">duplicate</span>}
                        <span className={`badge ${healthBadge} ml-1`}>{health}</span>
                      </td>
                      <td className="dim small">
                        {s.channel_identities.length === 0 ? (
                          "—"
                        ) : (
                          <div className="stack gap-0">
                            {s.channel_identities.map((ch, idx) => (
                              <div key={idx} className="mono">{ch.channel}: {ch.identity}</div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="dim small">
                        {s.bank_account_number ? (
                          <div className="stack gap-0">
                            <div className="mono">{s.bank_account_number}</div>
                            {s.bank_account_name && <div>{s.bank_account_name}</div>}
                            <div className="badge">changes require approval</div>
                          </div>
                        ) : (
                          <div className="stack gap-0">
                            <div>—</div>
                            <div className="badge">changes require approval</div>
                          </div>
                        )}
                      </td>
                      <td><span className="badge">{s.compliance_status}</span></td>
                      <td>
                        <span className="badge">{s.insurance_status}</span>
                        {s.insurance_expiry && <div className="dim small">expires {s.insurance_expiry}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
