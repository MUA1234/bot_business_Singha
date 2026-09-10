/**
 * Reusable Customers panel. Used by `/app/sales/customers` and the spatial workspace.
 * The caller must enforce permission (sales department or admin).
 */
import { supabaseReadClient } from "@/lib/supabase/read";
import { CustomersPanelContent } from "./CustomersPanelContent";
import type { ChannelIdentity, Customer, Conversation } from "./CustomersPanelContent";

export type PlainObject = Record<string, unknown>;

// Backward-compatible alias for existing consumers (e.g. spatial windows).
export const CustomersContent = CustomersPanelContent;

/** Detect identities claimed by more than one active customer in the same company. */
function findDuplicateIdentities(customers: Customer[]): Map<string, string[]> {
  const byIdentity = new Map<string, string[]>();
  for (const c of customers) {
    if (c.status !== "active") continue;
    for (const ch of c.channel_identities) {
      const key = `${ch.channel}:${ch.identity}`;
      const list = byIdentity.get(key) ?? [];
      if (!list.includes(c.id)) list.push(c.id);
      byIdentity.set(key, list);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [key, ids] of byIdentity) {
    if (ids.length > 1) duplicates.set(key, ids);
  }
  return duplicates;
}

export async function loadCustomersData(
  companyId: string,
  _userId?: string,
): Promise<PlainObject> {
  const db = supabaseReadClient();

  const [{ data: rows }, { data: convos }] = await Promise.all([
    db
      .from("customers")
      .select("id, name, email, phone, status")
      .eq("company_id", companyId)
      .order("name", { ascending: true })
      .limit(500),
    db
      .from("wa_conversations")
      .select("id, customer_wa_id, customer_name, status, last_inbound_at")
      .eq("company_id", companyId)
      .order("updated_at", { ascending: false })
      .limit(200),
  ]);

  const customerIds = (rows ?? []).map((r: any) => r.id);
  const { data: channelRows } = customerIds.length
    ? await db
        .from("channel_identities")
        .select("actor_id, channel, identity")
        .eq("company_id", companyId)
        .eq("actor_type", "customer")
        .in("actor_id", customerIds)
    : { data: [] };

  const channelsByCustomer = new Map<string, ChannelIdentity[]>();
  for (const ch of channelRows ?? []) {
    const list = channelsByCustomer.get(ch.actor_id as string) ?? [];
    list.push({ channel: ch.channel as string, identity: ch.identity as string });
    channelsByCustomer.set(ch.actor_id as string, list);
  }

  const customers: Customer[] = (rows ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    status: r.status,
    channel_identities: channelsByCustomer.get(r.id) ?? [],
  }));

  const duplicateIdentities = findDuplicateIdentities(customers);
  const duplicateCustomerIds = new Set<string>();
  for (const ids of duplicateIdentities.values()) {
    for (const id of ids) duplicateCustomerIds.add(id);
  }

  const conversations: Conversation[] = (convos ?? []) as Conversation[];

  return {
    customers,
    conversations,
    duplicateCustomerIds: Array.from(duplicateCustomerIds),
  };
}

interface CustomersPanelProps {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}

export default async function CustomersPanel({ companyId, userId, embedded }: CustomersPanelProps) {
  const data = await loadCustomersData(companyId, userId);
  return <CustomersPanelContent data={data} embedded={embedded ?? false} />;
}
