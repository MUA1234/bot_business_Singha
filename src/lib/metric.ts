/**
 * A health metric that distinguishes a real value from an unreadable source (§WP6.3).
 * The old pattern collapsed a DB error into 0, hiding outages. A Metric is either a
 * `value` (which may legitimately be zero) or `unavailable` (the query failed).
 */
export type Metric = { state: "value"; value: number } | { state: "unavailable" };

export const unavailable: Metric = { state: "unavailable" };
export const value = (n: number): Metric => ({ state: "value", value: n });

/**
 * Run a Supabase-style count query and classify the outcome. A thrown error OR a
 * returned `{ error }` both yield `unavailable` — never a misleading 0.
 */
export async function probeCount(
  run: () => Promise<{ count: number | null; error?: unknown }>,
): Promise<Metric> {
  try {
    const r = await run();
    if (r && (r as { error?: unknown }).error) return unavailable;
    return value(r.count ?? 0);
  } catch {
    return unavailable;
  }
}

/** Numeric value, or null when unavailable. */
export function metricNumber(m: Metric): number | null {
  return m.state === "value" ? m.value : null;
}

/** Display label: the number, or "unavailable". */
export function metricLabel(m: Metric): string {
  return m.state === "value" ? String(m.value) : "unavailable";
}

/** For an overall status: healthy (0), nonzero (>0), or unavailable. */
export function metricState(m: Metric): "zero" | "nonzero" | "unavailable" {
  if (m.state === "unavailable") return "unavailable";
  return m.value > 0 ? "nonzero" : "zero";
}
