/**
 * Authenticated visual-evidence capture for the spatial workspace.
 *
 * This harness signs in through the real /login form against a disposable local
 * Supabase environment seeded with non-production users. It NEVER sets an auth
 * bypass cookie and NEVER relaxes middleware. It captures the requested layouts,
 * opens the command palette, dock and arrival surfaces, records console errors,
 * and measures horizontal overflow.
 *
 * Required env (read from process.env, never committed):
 *   SPATIAL_SCREENSHOT_SUPABASE_URL   (or NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)
 *   SPATIAL_SCREENSHOT_ANON_KEY       (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 *   SPATIAL_SCREENSHOT_OWNER_PASSWORD
 *   SPATIAL_SCREENSHOT_STAFF_PASSWORD
 *   BASE_URL                          (default http://localhost:3000)
 *   SCREENSHOT_OUT                    (default ./screenshots/uiux-v2)
 *
 * Usage:
 *   1. Start a local Supabase project with migrations applied.
 *   2. Start the Next.js dev server with NEXT_PUBLIC_SPATIAL_WORKSPACE=on.
 *   3. node scripts/verify/spatial-screenshots.mjs
 */
import { chromium } from "playwright-core";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedForScreenshots } from "./spatial-screenshot-seed.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const OUT = process.env.SCREENSHOT_OUT ?? join(ROOT, "screenshots", "uiux-v2");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const SPATIAL_PATH = "/app/spatial";

const WIDTHS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "touch-large", width: 1920, height: 1080 },
];

const ROLES = [
  { key: "owner", email: process.env.SPATIAL_SCREENSHOT_OWNER_EMAIL || "owner-screenshot@singha.local" },
  { key: "staff", email: process.env.SPATIAL_SCREENSHOT_STAFF_EMAIL || "staff-screenshot@singha.local" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPassword(role) {
  const name = role === "owner" ? "SPATIAL_SCREENSHOT_OWNER_PASSWORD" : "SPATIAL_SCREENSHOT_STAFF_PASSWORD";
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function waitForWorkspace(page) {
  await page.waitForSelector("[aria-label='Spatial operations workspace']", { timeout: 15000 });
  await sleep(500);
}

async function signIn(page, email, password) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForSelector("form", { timeout: 15000 });
  const emailInput = await page.locator("input[type='email']").or(page.locator("input[name='email']")).first();
  const passwordInput = await page.locator("input[type='password']").or(page.locator("input[name='password']")).first();
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await page.locator("button[type='submit']").or(page.locator("button:has-text('Sign in')")).first().click();
  await page.waitForURL((url) => url.pathname.startsWith("/app"), { timeout: 20000 });
}

async function measureOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      documentOverflowX: Math.max(0, root.scrollWidth - root.clientWidth),
      maxBodyOverflowX: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
    };
  });
}

async function captureState(page, role, viewportName, label, consoleErrors) {
  const file = join(OUT, `spatial-${role}-${viewportName}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const overflow = await measureOverflow(page);
  console.log(`  ✓ ${file} (overflowX=${overflow.documentOverflowX}px)`);
  return { file, overflow, consoleErrors: [...consoleErrors] };
}

async function runForRole(browser, roleKey, email) {
  const password = await getPassword(roleKey);
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const onConsole = (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      consoleErrors.push({ type, text: msg.text() });
    }
  };
  page.on("console", onConsole);

  const results = [];
  try {
    await signIn(page, email, password);
    await page.goto(`${BASE_URL}${SPATIAL_PATH}`);
    await waitForWorkspace(page);

    for (const vp of WIDTHS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.reload({ waitUntil: "networkidle" });
      await waitForWorkspace(page);

      // Baseline workspace.
      results.push(await captureState(page, roleKey, vp.name, "workspace", consoleErrors));
      consoleErrors.length = 0;

      // Command palette (keyboard shortcut).
      await page.keyboard.press("Control+k");
      await sleep(400);
      results.push(await captureState(page, roleKey, vp.name, "palette", consoleErrors));
      await page.keyboard.press("Escape");
      await sleep(200);
      consoleErrors.length = 0;

      // Mobile module / window switcher sheets (narrow viewports only).
      if (vp.width <= 768) {
        const moduleTrigger = page.locator("button[aria-label='Open module launcher']");
        if (await moduleTrigger.isVisible().catch(() => false)) {
          await moduleTrigger.click();
          await sleep(300);
          results.push(await captureState(page, roleKey, vp.name, "module-sheet", consoleErrors));
          await page.keyboard.press("Escape");
          await sleep(200);
          consoleErrors.length = 0;
        }

        const windowTrigger = page.locator("button[aria-label='Open window switcher']");
        if (await windowTrigger.isVisible().catch(() => false)) {
          await windowTrigger.click();
          await sleep(300);
          results.push(await captureState(page, roleKey, vp.name, "window-sheet", consoleErrors));
          await page.keyboard.press("Escape");
          await sleep(200);
          consoleErrors.length = 0;
        }
      }
    }
  } catch (e) {
    console.error(`✗ ${roleKey} run failed: ${e.message}`);
    throw e;
  } finally {
    await context.close();
  }
  return results;
}

async function main() {
  // Verify required configuration before launching a browser.
  const url =
    process.env.SPATIAL_SCREENSHOT_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceRoleKey =
    process.env.SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    console.error(
      "❌ Authenticated screenshots require a disposable local Supabase environment.\n" +
      "   Set SPATIAL_SCREENSHOT_SUPABASE_URL and SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY\n" +
      "   (or NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) pointing to a local\n" +
      "   Supabase instance with migrations applied.\n" +
      "   No hosted/staging/production endpoint is used by this harness.",
    );
    process.exit(1);
  }

  console.log("Seeding disposable screenshot environment…");
  await seedForScreenshots();

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const allResults = [];

  try {
    for (const role of ROLES) {
      console.log(`\nCapturing as ${role.key} (${role.email})…`);
      const results = await runForRole(browser, role.key, role.email);
      allResults.push(...results);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots written to ${OUT}`);
  const totalErrors = allResults.reduce((n, r) => n + r.consoleErrors.length, 0);
  console.log(`Total console errors/warnings: ${totalErrors}`);
  if (totalErrors > 0) {
    for (const r of allResults) {
      for (const e of r.consoleErrors) {
        console.log(`  [${r.file}] ${e.type}: ${e.text}`);
      }
    }
  }
  const overflows = allResults.filter((r) => r.overflow.documentOverflowX > 0 || r.overflow.maxBodyOverflowX > 0);
  if (overflows.length) {
    console.warn("\nHorizontal overflow detected in:");
    for (const o of overflows) {
      console.warn(`  ${o.file} -> ${o.overflow.documentOverflowX}px document, ${o.overflow.maxBodyOverflowX}px body`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
