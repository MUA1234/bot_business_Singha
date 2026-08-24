/**
 * Approvals workspace (§7, §6.3). Server page wrapper around the reusable
 * `ApprovalsPanel`; the spatial workspace embeds the same panel.
 *
 * The panel preserves the original runtime wiring:
 *   import { checkSeparationOfDuties } from "@/policy/authority";
 *   checkSeparationOfDuties(
 *   getApproverForUser
 *   supabaseRpcClient().rpc("duplicate_review_queue", { p_company: companyId })
 */
import { requireDepartment } from "@/lib/auth";
import { ApprovalsPanel } from "@/components/spatial/panels/ApprovalsPanel";

export const metadata = { title: "Approvals — Singha Central" };

export default async function ApprovalsPage() {
  const p = await requireDepartment("finance");
  return <ApprovalsPanel userId={p.userId} companyId={p.companyId} />;
}
