"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js")
        .then((reg) => {
          // eslint-disable-next-line no-console
          console.log("[PWA] service worker registered:", reg.scope);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[PWA] service worker registration failed:", err);
        });
    }
  }, []);

  return null;
}
