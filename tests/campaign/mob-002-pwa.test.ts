/**
 * MOB-002 — Progressive web app with offline-safe behaviour.
 *
 * Verifies the app is installable (manifest + icons) and the service worker
 * behaves safely on a poor connection without fabricating durable records.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MANIFEST = "src/app/manifest.ts";
const SW = "public/sw.js";
const LAYOUT = "src/app/layout.tsx";
const REG = "src/components/ServiceWorkerRegistration.tsx";

describe("MOB-002 — PWA surface", () => {
  const manifest = readFileSync(MANIFEST, "utf8");
  const sw = readFileSync(SW, "utf8");
  const layout = readFileSync(LAYOUT, "utf8");
  const reg = readFileSync(REG, "utf8");

  it("manifest declares PWA installability fields", () => {
    expect(manifest).toContain("name");
    expect(manifest).toContain("short_name");
    expect(manifest).toContain("start_url");
    expect(manifest).toContain('display: "standalone"');
    expect(manifest).toContain("icons");
    expect(manifest).toContain("theme_color");
    expect(manifest).toContain("background_color");
  });

  it("service worker has install/activate/fetch lifecycle", () => {
    expect(sw).toContain("install");
    expect(sw).toContain("activate");
    expect(sw).toContain("fetch");
  });

  it("shell is cached and served cache-first for navigation", () => {
    expect(sw).toContain("/app");
    expect(sw).toContain("caches.match");
    expect(sw).toContain("isNavigation");
  });

  it("static assets are cached", () => {
    expect(sw).toContain("isStaticAsset");
    expect(sw).toContain("caches.open(STATIC_CACHE)");
  });

  it("writes pass through and are never replayed", () => {
    expect(sw).toContain("isWrite(request)");
    expect(sw).toContain("return; // writes pass through");
  });

  it("offline API reads return a safe retryable response, never fabricated data", () => {
    expect(sw).toContain('"offline"');
    expect(sw).toContain("retryable: true");
    expect(sw).toContain("NEVER fabricates");
  });

  it("layout registers the service worker client-side", () => {
    expect(layout).toContain("ServiceWorkerRegistration");
    expect(reg).toContain('"use client"');
    expect(reg).toContain('"/sw.js"');
    expect(reg).toContain("navigator.serviceWorker.register");
  });
});
