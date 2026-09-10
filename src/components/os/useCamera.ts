"use client";

import { useEffect, useRef } from "react";

/**
 * The virtual camera.
 *
 * Pointer movement influences the scene by at most ±1.5° horizontally, ±1°
 * vertically and a few pixels of depth — the caps live in tokens.css so no
 * component can exceed them. The intent is that the environment responds almost
 * subconsciously: no seasick parallax, no perspective wobble.
 *
 * It writes CSS custom properties on one element rather than re-rendering, so
 * the cost is a compositor transform per frame and nothing else. It disengages
 * entirely for:
 *   - a coarse pointer (a finger is not a camera; touch has its own gestures),
 *   - `prefers-reduced-motion: reduce`,
 *   - narrow viewports, where there is no room for depth to read.
 */
export function useCamera<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(pointer: fine)");
    const wide = window.matchMedia("(min-width: 1200px)");

    let frame = 0;
    let engaged = false;

    const reset = () => {
      el.style.setProperty("--cam-x", "0deg");
      el.style.setProperty("--cam-y", "0deg");
      el.style.setProperty("--cam-z", "0px");
    };

    const onMove = (event: PointerEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        // -1 … 1 across the viewport, from its centre.
        const nx = (event.clientX / window.innerWidth) * 2 - 1;
        const ny = (event.clientY / window.innerHeight) * 2 - 1;
        // The caps are read from the tokens, so reduced-motion (which zeroes
        // them) disengages the camera without this file knowing about it.
        const styles = getComputedStyle(document.documentElement);
        const tilt = parseFloat(styles.getPropertyValue("--cam-tilt-max")) || 0;
        const pitch = parseFloat(styles.getPropertyValue("--cam-pitch-max")) || 0;
        const dolly = parseFloat(styles.getPropertyValue("--cam-dolly-max")) || 0;

        el.style.setProperty("--cam-x", `${(nx * tilt).toFixed(3)}deg`);
        el.style.setProperty("--cam-y", `${(-ny * pitch).toFixed(3)}deg`);
        // Depth follows distance from centre: the scene settles back a little
        // as the pointer travels away from the middle of the room.
        const radial = Math.min(1, Math.hypot(nx, ny));
        el.style.setProperty("--cam-z", `${(-radial * dolly).toFixed(2)}px`);
      });
    };

    const sync = () => {
      const shouldEngage = fine.matches && wide.matches && !motion.matches;
      if (shouldEngage === engaged) return;
      engaged = shouldEngage;
      if (engaged) {
        window.addEventListener("pointermove", onMove, { passive: true });
      } else {
        window.removeEventListener("pointermove", onMove);
        reset();
      }
    };

    sync();
    motion.addEventListener?.("change", sync);
    fine.addEventListener?.("change", sync);
    wide.addEventListener?.("change", sync);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      motion.removeEventListener?.("change", sync);
      fine.removeEventListener?.("change", sync);
      wide.removeEventListener?.("change", sync);
    };
  }, []);

  return ref;
}
