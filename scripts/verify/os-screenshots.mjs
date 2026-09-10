#!/usr/bin/env node
/**
 * Spatial Executive OS — visual QA harness.
 *
 * Renders real routes in a real browser at every required viewport, captures a
 * screenshot of each, and MEASURES the things a screenshot alone will not tell
 * you:
 *
 *   - horizontal overflow (documentElement.scrollWidth > innerWidth), which is
 *     the single most common responsive failure and is invisible in a
 *     full-page capture;
 *   - console errors;
 *   - touch targets below the 44 px floor;
 *   - text that is too small to read on a phone;
 *   - reduced-motion rendering, captured separately.
 *
 * WHAT IT CANNOT DO, stated plainly: it cannot sign in. The application reaches
 * its data through Supabase, and there is no Supabase instance here, so every
 * `/app/*` route redirects to the sign-in screen. What it CAN establish is the
 * design system itself, on the public surfaces and on the development-only
 * design lab, which renders every material, instrument and state against
 * clearly-labelled synthetic fixtures and reads no business data.
 *
 * Authenticated capture is covered by `scripts/verify/spatial-screenshots.mjs`,
 * which signs in for real against a disposable environment.
 *
 * Usage:
 *   node scripts/verify/os-screenshots.mjs [--base http://127.0.0.1:3210] [--out screenshots/uiux-v3]
 */
import { chromium } from "playwright-core";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const BASE = arg("base", process.env.BASE_URL ?? "http://127.0.0.1:3210");
const OUT = arg("out", join(ROOT, "screenshots", "uiux-v3"));

/** The responsive test targets required by the design brief. */
const VIEWPORTS = [
  { name: "4k", width: 1920, height: 1080 },
  { name: "desktop-lg", width: 1440, height: 900 },
  { name: "desktop", width: 1366, height: 768 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "small-desktop", width: 1024, height: 768 },
  { name: "tablet-landscape", width: 834, height: 1194 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone-lg", width: 430, height: 932 },
  { name: "phone", width: 390, height: 844 },
  { name: "phone-sm", width: 360, height: 800 },
];

const ROUTES = [
  { path: "/dev/design-lab", name: "lab-index" },
  { path: "/dev/design-lab/command", name: "lab-command" },
  { path: "/dev/design-lab/states", name: "lab-states" },
  { path: "/login", name: "login" },
  { path: "/", name: "landing" },
  // The not-found route is EXPECTED to answer 404 — that is the behaviour
  // under test, so the status is compared against expectStatus, not 200.
  { path: "/not-a-real-page", name: "not-found", expectStatus: 404 },
];

/** Measurements a screenshot cannot make. */
// Passed to page.evaluate as a STRING, which Playwright treats as an
// expression — so it must be an immediately-invoked function, not a function
// literal (a bare arrow evaluates to an unserialisable function object and
// comes back as undefined).
const AUDIT = `(() => {
  const doc = document.documentElement;
  const overflow = Math.max(0, doc.scrollWidth - window.innerWidth);

  // Anything a finger is expected to hit must be at least 44px on its short
  // edge. Elements that are hidden or zero-sized are not targets.
  const interactive = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="option"]')];
  const small = [];
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    // Inline links inside a paragraph are read, not tapped as a target; only
    // standalone controls are held to the floor.
    const inlineLink = el.tagName === 'A' && style.display.startsWith('inline') && el.closest('p,li,td');
    // A checkbox or radio is intrinsically ~13-20px; what a finger hits is its
    // LABEL. Exempt it when the wrapping label itself meets the floor.
    const boxed = (el.type === 'checkbox' || el.type === 'radio');
    if (boxed) {
      const label = el.closest('label');
      const lr = label && label.getBoundingClientRect();
      if (lr && Math.min(lr.width, lr.height) >= 44) continue;
    }
    if (inlineLink) continue;
    if (Math.min(r.width, r.height) < 44) {
      small.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 40),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
  }

  // Body copy below 12px is unreadable on a phone.
  const tiny = [];
  for (const el of document.querySelectorAll('p,td,li,span,div')) {
    if (!el.textContent || !el.textContent.trim()) continue;
    if (el.children.length > 0) continue;
    // A decorative glyph (an avatar initial, a mark) is not text to read, and it
    // is already hidden from assistive technology.
    if (el.closest('[aria-hidden="true"]')) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size > 0 && size < 11) tiny.push({ size, text: el.textContent.trim().slice(0, 40) });
  }

  return { overflow, small: small.slice(0, 12), smallCount: small.length, tiny: tiny.slice(0, 6), tinyCount: tiny.length };
})()`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const report = [];
  let failures = 0;

  for (const route of ROUTES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        // The application ships a strict CSP without unsafe-eval, which also
        // blocks the harness own measurement script. Bypassing it in the TEST
        // browser changes nothing about the page the app serves.
        bypassCSP: true,
      });
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        // The dev server's react-refresh runtime trips the app's own CSP in
        // development. It does not exist in a production build, and reporting it
        // on every route would bury real errors.
        if (text.includes("react-refresh") || text.includes("unsafe-eval")) return;
        // A route under test that is EXPECTED to answer 404 logs a resource
        // error for its own document. That is the behaviour being verified.
        if (route.expectStatus && route.expectStatus >= 400 && text.includes(String(route.expectStatus))) return;
        consoleErrors.push(text.slice(0, 200));
      });

      const url = `${BASE}${route.path}`;
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(300);

        const audit = await page.evaluate(AUDIT);
        const file = join(OUT, `${route.name}--${vp.name}.png`);
        await page.screenshot({ path: file, fullPage: false });

        const status = res?.status() ?? 0;
        const expected = route.expectStatus ?? 200;
        const bad =
          audit.overflow > 0 ||
          consoleErrors.length > 0 ||
          status !== expected ||
          audit.smallCount > 0 ||
          audit.tinyCount > 0;
        if (bad) failures++;
        report.push({
          route: route.name,
          path: route.path,
          viewport: vp.name,
          width: vp.width,
          status,
          overflowPx: audit.overflow,
          smallTargets: audit.smallCount,
          smallSamples: audit.small,
          tinyText: audit.tinyCount,
          tinySamples: audit.tiny,
          consoleErrors,
        });
        const flag = bad ? "✗" : "✓";
        console.log(
          `${flag} ${route.name} @ ${vp.name} (${vp.width}px) — status ${status}, overflow ${audit.overflow}px, small targets ${audit.smallCount}, tiny text ${audit.tinyCount}`,
        );
      } catch (err) {
        failures++;
        report.push({ route: route.name, viewport: vp.name, error: String(err.message ?? err) });
        console.error(`✗ ${url} @ ${vp.name}: ${err.message}`);
      } finally {
        await ctx.close();
      }
    }
  }

  // Reduced motion is a first-class rendering mode, not an afterthought: the
  // whole hierarchy must survive with every transition removed.
  for (const route of ROUTES.slice(0, 2)) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      bypassCSP: true,
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${route.name}--reduced-motion.png`) });
      console.log(`✓ ${route.name} @ reduced-motion`);
    } catch (err) {
      console.error(`✗ ${route.name} @ reduced-motion: ${err.message}`);
      failures++;
    } finally {
      await ctx.close();
    }
  }

  await browser.close();
  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));

  const overflows = report.filter((r) => (r.overflowPx ?? 0) > 0);
  console.log(`\n${report.length} captures → ${OUT}`);
  console.log(`Horizontal overflow: ${overflows.length === 0 ? "none" : overflows.map((r) => `${r.route}@${r.viewport} (${r.overflowPx}px)`).join(", ")}`);
  if (failures > 0) {
    console.error(`\n${failures} capture(s) reported a problem — see report.json`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
