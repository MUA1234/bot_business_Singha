#!/usr/bin/env node
/**
 * Spatial workspace — viewport, keyboard and accessibility audit.
 *
 * Drives a REAL browser against the REAL signed-in workspace at four viewports, and
 * writes a JSON artifact plus a SHA-256 of it. Nothing binary is committed: the report
 * records the checksum and the SHA it was produced at, and the artifact itself stays a
 * local/CI file (F-011 / item 8 of the remediation brief).
 *
 * It authenticates through the real GoTrue password flow — there is no bypass.
 *
 * Usage:
 *   HST_KEYS_FILE=... DEV_FIXTURE_PASSWORD=... node scripts/hard-scenario/spatial-viewport-audit.mjs
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const APP = process.env.HST_APP_URL ?? "http://127.0.0.1:3241";
const GATEWAY = process.env.HST_GATEWAY_URL ?? "http://127.0.0.1:54321";
const KEYS_FILE = process.env.HST_KEYS_FILE ?? "";
const PASSWORD = process.env.DEV_FIXTURE_PASSWORD ?? "";
const EMAIL = process.env.HST_AUDIT_EMAIL ?? "fixture.owner@singha.local";
const OUT_DIR = process.env.HST_ARTIFACT_DIR ?? "artifacts/hard-scenario";

const CHROME_CANDIDATES = [
  process.env.BROWSER_EXECUTABLE,
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1194", "chrome-win", "chrome.exe"),
  join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p) => p && existsSync(p));

const VIEWPORTS = [
  { name: "mobile-390", width: 390, height: 844, touch: true },
  { name: "tablet-768", width: 768, height: 1024, touch: true },
  { name: "desktop-1440", width: 1440, height: 900, touch: false },
  { name: "large-touch-2560", width: 2560, height: 1440, touch: true },
];

/** Collected in the page. Pure measurement — it changes nothing. */
function auditInPage() {
  const de = document.documentElement;
  const focusableSel = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const focusable = Array.from(document.querySelectorAll(focusableSel)).filter(visible);

  /**
   * Is this element genuinely unreachable, or merely scrolled out of view?
   *
   * An earlier version of this audit compared each element against the viewport alone
   * and reported the dock's "Restore <window>" buttons as unreachable at 1440px. They
   * are not: `.spatial-dock` is `overflow-x: auto`, and scrolling it brings them in.
   * Reporting that would have been a false finding, so reachability now accounts for
   * scrollable ancestors — an element is only unreachable if nothing between it and the
   * document can scroll it into view.
   */
  const hasScrollableAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const scrollsX = /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
      const scrollsY = /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
      if (scrollsX || scrollsY) return true;
    }
    return false;
  };

  const offscreenFocusable = focusable.filter((el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return false;
    const outside = r.left >= de.clientWidth || r.right <= 0;
    return outside && !hasScrollableAncestor(el);
  });
  const tiny = focusable.filter((el) => {
    const r = el.getBoundingClientRect();
    // WCAG 2.5.8 target size (minimum) is 24x24 CSS px.
    return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
  });
  return {
    viewportWidth: window.innerWidth,
    horizontalOverflow: de.scrollWidth > de.clientWidth + 1,
    overflowBy: Math.max(0, de.scrollWidth - de.clientWidth),
    focusableTotal: focusable.length,
    offscreenFocusable: offscreenFocusable.length,
    offscreenSamples: offscreenFocusable.slice(0, 5).map((el) => ({
      tag: el.tagName,
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 45),
    })),
    smallTargets: tiny.length,
    smallTargetSamples: tiny.slice(0, 5).map((el) => ({
      tag: el.tagName,
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    })),
    hasSkipLink: !!document.querySelector('a[href^="#main"]'),
    landmarks: {
      main: document.querySelectorAll("main").length,
      nav: document.querySelectorAll("nav").length,
      banner: document.querySelectorAll("header,[role=banner]").length,
    },
    imagesMissingAlt: Array.from(document.querySelectorAll("img")).filter((i) => !i.hasAttribute("alt")).length,
    buttonsWithoutName: Array.from(document.querySelectorAll("button"))
      .filter(visible)
      .filter((b) => !(b.getAttribute("aria-label") || b.textContent || "").trim()).length,
    openWindows: document.querySelectorAll('[aria-label="Close window"]').length,
    localStorageKeys: (() => { try { return Object.keys(localStorage); } catch { return ["<blocked>"]; } })(),
  };
}

async function main() {
  if (!CHROME_CANDIDATES.length) { console.error("no chromium/chrome executable found"); process.exit(2); }
  if (!KEYS_FILE || !PASSWORD) { console.error("HST_KEYS_FILE and DEV_FIXTURE_PASSWORD are required"); process.exit(2); }
  for (const u of [APP, GATEWAY]) {
    const h = new URL(u).hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(h)) { console.error(`refusing non-loopback ${u}`); process.exit(2); }
  }

  const keys = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  const browser = await chromium.launch({ executablePath: CHROME_CANDIDATES[0], headless: true });
  const results = [];
  const keyboard = {};

  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.touch,
        isMobile: vp.width < 800,
        reducedMotion: "reduce", // exercise the reduced-motion path
      });
      const page = await context.newPage();

      // Real sign-in through the real form. No bypass.
      await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
      if (page.url().includes("/login")) {
        await page.fill('input[name="username"], input[type="text"]', EMAIL.split("@")[0]);
        await page.fill('input[type="password"]', PASSWORD);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
          page.click('button[type="submit"], button:has-text("Sign in")'),
        ]);
      }
      await page.goto(`${APP}/app/spatial`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);

      const audit = await page.evaluate(auditInPage);
      results.push({ viewport: vp.name, requested: { w: vp.width, h: vp.height, touch: vp.touch }, ...audit });

      // Keyboard-only reachability, measured once at the desktop viewport.
      if (vp.name === "desktop-1440") {
        const reached = new Set();
        for (let i = 0; i < 40; i += 1) {
          await page.keyboard.press("Tab");
          const label = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            return (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 45);
          });
          if (label) reached.add(label);
        }
        keyboard.tabStopsReached = reached.size;
        keyboard.sample = Array.from(reached).slice(0, 12);
        keyboard.commandPaletteReachable = Array.from(reached).some((l) => /command palette|search or command/i.test(l));
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const artifact = {
    generatedFor: "hard-scenario spatial viewport audit",
    app: APP,
    viewports: results,
    keyboard,
    notes: [
      "reducedMotion=reduce was set for every context, so these measurements are the reduced-motion path.",
      "Sign-in used the real GoTrue password flow through the real login form.",
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, "spatial-viewport-audit.json");
  const json = JSON.stringify(artifact, null, 2);
  writeFileSync(outPath, json);
  const sha = createHash("sha256").update(json).digest("hex");
  writeFileSync(join(OUT_DIR, "spatial-viewport-audit.json.sha256"), `${sha}  spatial-viewport-audit.json\n`);

  console.log(json);
  console.log(`\nartifact: ${outPath}`);
  console.log(`sha256:   ${sha}`);

  // Fail the audit on the properties that matter.
  const problems = [];
  for (const r of results) {
    if (r.horizontalOverflow) problems.push(`${r.viewport}: horizontal overflow by ${r.overflowBy}px`);
    if (r.offscreenFocusable > 0) problems.push(`${r.viewport}: ${r.offscreenFocusable} focusable element(s) off-screen`);
    if (r.buttonsWithoutName > 0) problems.push(`${r.viewport}: ${r.buttonsWithoutName} button(s) with no accessible name`);
    if (r.imagesMissingAlt > 0) problems.push(`${r.viewport}: ${r.imagesMissingAlt} image(s) with no alt`);
    if (!r.hasSkipLink) problems.push(`${r.viewport}: no skip link`);
    if (r.localStorageKeys.some((k) => !/^singha-spatial-layout:|^singha-/.test(k))) {
      problems.push(`${r.viewport}: unexpected localStorage key(s): ${r.localStorageKeys.join(", ")}`);
    }
  }
  if (problems.length) {
    console.error(`\nAUDIT FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nAUDIT PASSED");
}

main().catch((e) => { console.error("audit crashed:", e.message); process.exit(2); });
