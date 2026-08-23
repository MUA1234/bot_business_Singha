import { SkeletonTable } from "@/components/ui";

/**
 * Authenticated-shell loading state. Renders a skeleton table inside the existing
 * AppShell layout so the user sees the navigation immediately while the page data
 * streams in.
 */
export default function AppLoading() {
  return (
    <div className="stack gap-3" aria-busy="true" aria-label="Loading page content">
      <div>
        <div className="skeleton" style={{ width: 220, height: 32, marginBottom: 8 }} />
        <div className="skeleton" style={{ width: 320, height: 16 }} />
      </div>
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
