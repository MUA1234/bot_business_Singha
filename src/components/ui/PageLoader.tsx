"use client";

import { SkeletonTable } from "./Skeleton";

interface PageLoaderProps {
  rows?: number;
  cols?: number;
  titleWidth?: number;
  subtitleWidth?: number;
}

/**
 * On-brand loading placeholder for route-level `loading.tsx`. Keeps the glass-panel
 * aesthetic and avoids layout shift by mirroring the typical page shape.
 */
export function PageLoader({ rows = 6, cols = 4, titleWidth = 220, subtitleWidth = 320 }: PageLoaderProps) {
  return (
    <div className="stack gap-3" aria-busy="true" aria-label="Loading page content">
      <div>
        <div className="skeleton" style={{ width: titleWidth, height: 32, marginBottom: 8 }} aria-hidden="true" />
        <div className="skeleton" style={{ width: subtitleWidth, height: 16 }} aria-hidden="true" />
      </div>
      <SkeletonTable rows={rows} cols={cols} />
    </div>
  );
}
