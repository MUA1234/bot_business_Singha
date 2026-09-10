import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MANIFEST_TS = "src/app/manifest.ts";
const SW = "public/sw.js";
const LAYOUT = "src/app/layout.tsx";

describe("MOB-002 — PWA foundation", () => {
  it("exports a web app manifest from src/app/manifest.ts", () => {
    const m = readFileSync(MANIFEST_TS, "utf8");
    expect(m).toContain("export default function manifest");
    expect(m).toContain('name: "Singha Central"');
    expect(m).toContain('short_name:');
    expect(m).toContain('display: "standalone"');
    expect(m).toContain('start_url:');
    expect(m).toContain("icons:");
  });

  it("includes a service worker at public/sw.js", () => {
    const sw = readFileSync(SW, "utf8");
    expect(sw).toContain('self.addEventListener("install"');
    expect(sw).toContain('self.addEventListener("activate"');
    expect(sw).toContain('self.addEventListener("fetch"');
  });

  it("caches the shell on install", () => {
    const sw = readFileSync(SW, "utf8");
    expect(sw).toContain("caches.open");
    expect(sw).toContain("addAll");
    expect(sw).toContain("/app");
  });

  it("never caches or replays write requests", () => {
    const sw = readFileSync(SW, "utf8");
    expect(sw).toContain('"POST"');
    expect(sw).toContain('"PUT"');
    expect(sw).toContain('"DELETE"');
    expect(sw).toContain('"PATCH"');
    // Writes should pass through to the network; they are not cached/replayed.
    expect(sw).toContain("isWrite(request)");
  });

  it("returns a safe offline response for API/data reads, not a fabricated record", () => {
    const sw = readFileSync(SW, "utf8");
    expect(sw).toContain('"offline"');
    expect(sw).toContain("503");
    expect(sw).toContain("NEVER fabricates");
  });

  it("registers the service worker from the root layout", () => {
    const layout = readFileSync(LAYOUT, "utf8");
    expect(layout).toContain("ServiceWorkerRegistration");
    const reg = readFileSync("src/components/ServiceWorkerRegistration.tsx", "utf8");
    expect(reg).toContain("navigator.serviceWorker.register");
    expect(reg).toContain('"/sw.js"');
  });
});
