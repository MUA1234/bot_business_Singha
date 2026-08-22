"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access";
import { supabaseRpcClient } from "@/lib/supabase/read";
import { REVIEWER_ROLE } from "@/app/app/admin/inbound-review/capability";

export interface SetupState {
  error?: string;
  ok?: string;
}

/**
 * Map a receiving account to this company (R1 §5, OF-004).
 *
 * TWO independent checks, as everywhere in this codebase: the app requires the capability here, and
 * `admin_upsert_channel_account` re-checks the NAMED ACTOR at the database. The mapping is created
 * INACTIVE — creating one changes nothing until an owner activates it deliberately, and a conflict
 * with another company is reported rather than silently taken over.
 */
export async function addChannelAccount(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const channel = String(formData.get("channel") ?? "whatsapp").trim();
  const account = String(formData.get("account") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim() || null;
  if (!account) return { error: "Enter the receiving account id (WhatsApp: the phone number id from Meta)." };

  let membership;
  try {
    membership = await requireCapability("admin.organisation.manage");
  } catch {
    return { error: "You do not have permission to change channel configuration." };
  }

  const { data, error } = await supabaseRpcClient().rpc("admin_upsert_channel_account", {
    p_company: membership.companyId,
    p_channel: channel,
    p_provider_account_id: account,
    p_label: label,
    p_actor: membership.userId,
  });
  if (error) return { error: `Could not save the mapping: ${error.message}` };

  const row = Array.isArray(data) ? data[0] : data;
  const conflict = (row as { conflict?: string } | null)?.conflict;
  if (conflict === "claimed_by_another_company") {
    return { error: "That account is already active for another company. Deactivate it there first — which company owns a number is your decision, not something this screen should take over." };
  }
  revalidatePath("/app/admin/inbound-setup");
  return {
    ok: (row as { created?: boolean } | null)?.created
      ? "Mapping saved. It is INACTIVE until you activate it."
      : "Mapping updated.",
  };
}

/** Activate or deactivate a mapping. Activation re-validates the conflict at that moment. */
export async function setChannelAccountActive(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const id = String(formData.get("accountId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";
  if (!id) return { error: "No mapping selected." };

  let membership;
  try {
    membership = await requireCapability("admin.organisation.manage");
  } catch {
    return { error: "You do not have permission to change channel configuration." };
  }

  const { data, error } = await supabaseRpcClient().rpc("admin_set_channel_account_active", {
    p_company: membership.companyId,
    p_account: id,
    p_active: active,
    p_actor: membership.userId,
  });
  if (error) return { error: `Could not change the mapping: ${error.message}` };

  const row = Array.isArray(data) ? data[0] : data;
  if ((row as { conflict?: string } | null)?.conflict === "claimed_by_another_company") {
    return { error: "Another company activated that account in the meantime. Nothing was changed." };
  }
  revalidatePath("/app/admin/inbound-setup");
  return { ok: active ? "Mapping activated." : "Mapping deactivated." };
}

/**
 * Give someone — or take away — a role that lets them work the inbound review queue (OF-005).
 * The database refuses self-elevation and any role outside a closed list.
 */
export async function setReviewerRole(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const userId = String(formData.get("userId") ?? "").trim();
  const roleKey = String(formData.get("roleKey") ?? "finance_reviewer").trim();
  const grant = String(formData.get("grant") ?? "") === "true";
  if (!userId) return { error: "No person selected." };
  // THIS screen grants ONE role. The database's list is wider on purpose (a company also has to be
  // able to appoint managers), but a hidden field in this form is client-supplied, and "the UI only
  // ever sends finance_reviewer" is not a control. The reviewer screen enforces the reviewer role.
  if (roleKey !== REVIEWER_ROLE) {
    return { error: `This screen only assigns the ${REVIEWER_ROLE} role.` };
  }

  let membership;
  try {
    membership = await requireCapability("admin.identity.manage");
  } catch {
    return { error: "You do not have permission to change what someone can do." };
  }

  const { error } = await supabaseRpcClient().rpc("admin_set_membership_role", {
    p_company: membership.companyId,
    p_user: userId,
    p_role_key: roleKey,
    p_grant: grant,
    p_actor: membership.userId,
  });
  if (error) return { error: `Could not change the role: ${error.message}` };

  revalidatePath("/app/admin/inbound-setup");
  return { ok: grant ? "Role granted." : "Role removed." };
}
