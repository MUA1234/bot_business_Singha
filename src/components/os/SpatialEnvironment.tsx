"use client";

import { useEffect, useState } from "react";

/**
 * The environment the interface floats in.
 *
 * Obsidian ground, a smoky aubergine mass, one soft key light, a champagne
 * bounce at the far edge, and a single horizon line that gives every surface
 * something to float ABOVE. Entirely CSS — no video, no canvas, no WebGL — so
 * it costs nothing on the critical path, works offline, and cannot fail to a
 * blank frame.
 *
 * Two things are decided here and nowhere else:
 *
 *   1. PERFORMANCE TIER. Measured from the device, written to <html data-tier>.
 *      A tier only ever removes atmosphere (blur, saturation) — never a
 *      control, a label, a route or a piece of information. `light` still shows
 *      every surface; it just paints them opaque instead of blurred.
 *
 *   2. DOMAIN CHARACTER. The same room lit differently per module, so Finance
 *      feels analytical and People feels warmer without becoming a separate
 *      website.
 *
 * The layer is inert: fixed, pointer-events:none, aria-hidden, not focusable.
 */
export type EnvDomain =
  | "command"
  | "finance"
  | "people"
  | "projects"
  | "operations"
  | "crm"
  | "ai";

function measureTier(): "high" | "standard" | "light" {
  if (typeof window === "undefined") return "standard";

  // A user asking for reduced motion is not asking for a lower tier; motion and
  // atmosphere are separate preferences and are handled separately.
  const nav = window.navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };

  if (nav.connection?.saveData) return "light";

  const memory = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 4;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const wide = window.innerWidth >= 1200;

  // backdrop-filter is the expensive part of this design. Where it is not
  // supported at all, drop straight to the opaque tier so panels stay readable
  // instead of turning into flat translucent rectangles over the environment.
  const supportsBackdrop =
    typeof CSS !== "undefined" &&
    (CSS.supports?.("backdrop-filter", "blur(4px)") ||
      CSS.supports?.("-webkit-backdrop-filter", "blur(4px)"));
  if (!supportsBackdrop) return "light";

  if (memory <= 2 || cores <= 2) return "light";
  if (memory <= 4 || cores <= 4 || (coarse && !wide)) return "standard";
  return wide ? "high" : "standard";
}

export function SpatialEnvironment({ domain = "command" }: { domain?: EnvDomain }) {
  const [tier, setTier] = useState<"high" | "standard" | "light" | null>(null);

  useEffect(() => {
    const apply = () => {
      const next = measureTier();
      setTier(next);
      document.documentElement.dataset.tier = next;
    };
    apply();
    window.addEventListener("resize", apply, { passive: true });
    return () => window.removeEventListener("resize", apply);
  }, []);

  return (
    <div className="env" data-domain={domain} data-tier={tier ?? "standard"} aria-hidden="true">
      <div className="env-field" />
      <div className="env-key" />
      <div className="env-bounce" />
      <div className="env-horizon" />
      {/* Grain is the cheapest layer and the one that stops large flat
       * gradients banding on an 8-bit panel, so it survives every tier. */}
      <div className="env-grain" />
    </div>
  );
}

export default SpatialEnvironment;
