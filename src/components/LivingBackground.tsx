"use client";

import { useEffect, useState } from "react";

const WEBM = "/media/singha-living-background.webm";
const MP4 = "/media/singha-living-background.mp4";
const MP4_MOBILE = "/media/singha-living-background-mobile.mp4";
export const LIVING_BG_POSTER = "/media/singha-living-background-poster.jpg";

/**
 * The Singha "living background" — a fixed, silent, seamless 12s loop behind the whole app.
 *
 * Loading strategy (deliberate): the server renders the <video> with its POSTER but with NO source,
 * so the first frame paints immediately (no hero flash, zero video bytes on the critical path and
 * nothing blocking LCP). After mount we attach EXACTLY ONE source — mobile MP4 on small screens,
 * VP9 WebM where supported, else H.264 MP4 — so a device never downloads two encodings.
 *
 * `prefers-reduced-motion: reduce` ⇒ no source is ever attached and the poster remains, preserving
 * the identical dark premium look with no motion (and no video download at all). The preference is
 * re-evaluated live, so toggling it at the OS level takes effect without a reload.
 *
 * The layer is inert: fixed, pointer-events:none, aria-hidden, not focusable — it can never
 * intercept a click or a tab stop, and screen readers ignore it.
 */
export default function LivingBackground() {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const small = window.matchMedia("(max-width: 767px)");

    const sync = () => {
      if (motion.matches) {
        setSrc(null); // static poster only
        return;
      }
      if (small.matches) {
        setSrc(MP4_MOBILE);
        return;
      }
      const probe = document.createElement("video");
      const webmOk = probe.canPlayType('video/webm; codecs="vp9"') !== "";
      setSrc(webmOk ? WEBM : MP4);
    };

    sync();
    motion.addEventListener?.("change", sync);
    small.addEventListener?.("change", sync);
    return () => {
      motion.removeEventListener?.("change", sync);
      small.removeEventListener?.("change", sync);
    };
  }, []);

  return (
    <div className="singha-living-bg" aria-hidden="true">
      <video
        // `key` forces a fresh element when the chosen source changes (e.g. reduced-motion toggled),
        // which is the reliable way to make a browser drop/pick up a new src.
        key={src ?? "poster-only"}
        src={src ?? undefined}
        poster={LIVING_BG_POSTER}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        tabIndex={-1}
        disablePictureInPicture
      />
    </div>
  );
}
