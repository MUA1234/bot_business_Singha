"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previousFocus.current = document.activeElement as HTMLElement | null;

    const container = ref.current;
    if (!container) return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0] ?? container;
    first.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const firstNode = nodes[0]!;
      const lastNode = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault();
        lastNode.focus();
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault();
        firstNode.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [active]);

  return ref;
}
