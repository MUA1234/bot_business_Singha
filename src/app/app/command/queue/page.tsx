import { requireAdmin } from "@/lib/auth";
import { ManagementQueuePanel } from "@/components/spatial/panels/ManagementQueuePanel";

export const metadata = { title: "Management Queue — Singha Central" };

/**
 * The flat 2D route for the management queue. It renders the SAME panel the spatial
 * workspace embeds, so the flat surface is never a lesser copy of the spatial one — the
 * fallback UX-001/D-5 requires is the same component, not a reimplementation.
 */
export default async function ManagementQueuePage() {
  const admin = await requireAdmin();
  return (
    <div className="stack gap-3">
      <div>
        <h1>Management Queue</h1>
        <p className="muted mt-1">
          Cross-department items needing attention. A recommendation here has been proposed,
          not carried out.
        </p>
      </div>
      <ManagementQueuePanel companyId={admin.companyId} />
    </div>
  );
}
