/**
 * UI/UX v1 polish — browser screenshot harness.
 *
 * Captures public and unauthenticated pages at the three required widths.
 * Authenticated pages require a local Supabase instance with seeded test users
 * and are skipped with a logged notice when no session can be established.
 */
import { chromium } from "playwright-core";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const OUT = process.env.SCREENSHOT_OUT ?? join(ROOT, "screenshots", "uiux-v1");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const WIDTHS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const PAGES = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/privacy", name: "privacy" },
  { path: "/terms", name: "terms" },
  { path: "/data-deletion", name: "data-deletion" },
  { path: "/not-a-real-page", name: "not-found" },
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(400);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({});

  for (const pageSpec of PAGES) {
    for (const vp of WIDTHS) {
      const page = await ctx.newPage({ viewport: { width: vp.width, height: vp.height } });
      const url = `${BASE_URL}${pageSpec.path}`;
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await waitForReady(page);
        const file = join(OUT, `${pageSpec.name}-${vp.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`✓ ${file} (${res?.status() ?? "unknown"})`);
      } catch (err) {
        console.error(`✗ ${url} @ ${vp.name}: ${err.message}`);
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
  console.log(`Screenshots written to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
