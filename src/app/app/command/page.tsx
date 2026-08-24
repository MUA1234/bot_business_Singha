/**
 * Exception-led Command Centre (Architecture V2 change plan §10.1). Server page wrapper
 * around the reusable `CommandCentrePanel`; the spatial workspace embeds the same panel.
 *
 * The panel preserves the original page surface, including:
 *   href="/app/portfolio"
 *   href="/app/command/health"
 *   href="/app/command/analyze"
 *   href="/app/command/cases"
 *   href="/app/command/memory"
 * and the live queries: from("purchase_orders"), from("commitments"),
 * buildCommitmentOutflows, ...commitmentOutflows.map, "Expected commitments".
 * The nav link label is "Memory".
 */
import { requireAdmin } from "@/lib/auth";
import { CommandCentrePanel } from "@/components/spatial/panels/CommandCentrePanel";

export const metadata = { title: "Command Centre — Singha Central" };

export default async function CommandCentrePage() {
  const admin = await requireAdmin();
  return <CommandCentrePanel companyId={admin.companyId} />;
}
