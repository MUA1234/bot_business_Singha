#!/usr/bin/env node
/**
 * AUTHENTICATED visual QA — the real application, really signed in.
 *
 * Signs in through the real `/login` form against a disposable LOCAL Supabase
 * stack, then renders every management surface at the required viewports and
 * measures what a screenshot cannot show: horizontal overflow, console errors,
 * touch targets below 44 px, and text below 11 px.
 *
 * There is NO authentication bypass. No cookie is forged, no middleware is
 * skipped, no permission is relaxed. The harness holds a real session issued by
 * GoTrue in exchange for a real password, exactly as a person would.
 *
 * SAFETY: refuses to run against a non-loopback base URL, so it can never point
 * at staging or production.
 *
 * Required env:
 *   DEV_FIXTURE_PASSWORD   the password the fixture seed was run with
 * Optional:
 *   BASE_URL               defaults to http://127.0.0.1:3230
 *   SCREENSHOT_OUT         defaults to screenshots/uiux-v3-auth
 *
 * Usage:
 *   node scripts/verify/authenticated-screenshots.mjs [--role owner] [--viewport desktop-lg]
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

const BASE = arg("base", process.env.BASE_URL ?? "http://127.0.0.1:3230");
const OUT = arg("out", process.env.SCREENSHOT_OUT ?? join(ROOT, "screenshots", "uiux-v3-auth"));
const PASSWORD = process.env.DEV_FIXTURE_PASSWORD;
const ONLY_ROLE = arg("role", null);
const ONLY_VIEWPORT = arg("viewport", null);

if (!PASSWORD) {
  console.error("authenticated-screenshots: DEV_FIXTURE_PASSWORD is required.");
  process.exit(2);
}
{
  const host = new URL(BASE).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`authenticated-screenshots: refusing a non-loopback base URL (${host}).`);
    process.exit(2);
  }
}

const VIEWPORTS = [
  { name: "4k", width: 1920, height: 1080 },
  { name: "desktop-lg", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1194 },
  { name: "mobile", width: 390, height: 844 },
];

/**
 * The management surfaces under review, in the order the brief lists them.
 * `role` names the fixture user whose entitlement the screen requires.
 */
const SCREENS = [
  { name: "01-command-centre", path: "/app/command", role: "owner", title: "Owner/CEO Command Centre" },
  { name: "02-ai-operations", path: "/app/ai", role: "owner", title: "AI Manager / AI operations" },
  { name: "03-approvals", path: "/app/finance/approvals", role: "finance", title: "Approval / decision focus" },
  { name: "04-work", path: "/app/operations/tasks", role: "owner", title: "Work command centre" },
  { name: "05-task-detail", path: "TASK_DETAIL", role: "owner", title: "Task workspace" },
  { name: "06-projects", path: "/app/operations/projects", role: "owner", title: "Projects portfolio" },
  { name: "07-project-room", path: "PROJECT_DETAIL", role: "owner", title: "Project command room" },
  { name: "08-people", path: "/app/hr", role: "owner", title: "Workforce / People" },
  { name: "09-capacity", path: "/app/hr/capacity", role: "owner", title: "Capacity" },
  { name: "10-finance", path: "/app/finance", role: "owner", title: "Finance control room" },
  { name: "11-accounting-journals", path: "/app/finance/journals", role: "finance", title: "Accounting — journals" },
  { name: "12-trial-balance", path: "/app/finance/trial-balance", role: "finance", title: "Accounting — trial balance" },
  { name: "13-receivables", path: "/app/finance/receivables", role: "finance", title: "Receivables & payables" },
  { name: "14-customers", path: "/app/sales", role: "owner", title: "CRM relationship field" },
  { name: "15-customer-360", path: "CONVERSATION", role: "owner", title: "Customer 360 / conversation" },
  { name: "16-messages", path: "/app/messages", role: "owner", title: "Communications inbox" },
  { name: "17-calendar", path: "/app/calendar", role: "owner", title: "Calendar & commitments" },
  { name: "18-documents", path: "/app/documents", role: "owner", title: "Documents & knowledge" },
  { name: "19-assets", path: "/app/fleet", role: "owner", title: "Asset control tower" },
  { name: "20-risk", path: "/app/legal", role: "owner", title: "Risk & governance" },
  { name: "21-health", path: "/app/admin/health", role: "owner", title: "System health" },
  { name: "22-audit", path: "/app/admin/audit", role: "owner", title: "Audit trail" },
  { name: "23-my-work", path: "/app/me", role: "staff", title: "Employee cockpit" },
  { name: "24-procurement", path: "/app/procurement", role: "owner", title: "Procurement" },
  { name: "25-admin", path: "/app/admin", role: "owner", title: "Owner admin overview" },
];

const AUDIT = `(() => {
  const doc = document.documentElement;
  const overflow = Math.max(0, doc.scrollWidth - window.innerWidth);
  const interactive = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="option"]')];
  const small = [];
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (el.closest('[aria-hidden="true"]')) continue;
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
      small.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 50),
        text: (el.textContent || '').trim().slice(0, 36), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  const tiny = [];
  for (const el of document.querySelectorAll('p,td,li,span,div')) {
    if (!el.textContent || !el.textContent.trim() || el.children.length > 0) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size > 0 && size < 11) tiny.push({ size, text: el.textContent.trim().slice(0, 36) });
  }
  return {
    overflow,
    small: small.slice(0, 10), smallCount: small.length,
    tiny: tiny.slice(0, 6), tinyCount: tiny.length,
    // Proof the page rendered real content rather than an error or empty shell.
    hasRail: !!document.querySelector('.rail'),
    headline: (document.querySelector('.page-title, h1')?.textContent || '').trim().slice(0, 80),
    fixtureMarkers: document.body.innerHTML.split('FIXTURE').length - 1,
  };
})()`;

async function signIn(context, username) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", username);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.close();
}

/** Resolve the fixture ids that only exist after a seed, so links are real. */
async function resolveDynamicPaths(context) {
  const page = await context.newPage();
  const paths = {};
  await page.goto(`${BASE}/app/operations/tasks`, { waitUntil: "networkidle" });
  paths.TASK_DETAIL = await page.evaluate(() => {
    const a = document.querySelector('a[href^="/app/operations/tasks/"]');
    return a ? new URL(a.href).pathname : null;
  });
  await page.goto(`${BASE}/app/operations/projects`, { waitUntil: "networkidle" });
  paths.PROJECT_DETAIL = await page.evaluate(() => {
    const a = document.querySelector('a[href^="/app/operations/projects/"]');
    return a ? new URL(a.href).pathname : null;
  });
  await page.goto(`${BASE}/app/messages`, { waitUntil: "networkidle" });
  paths.CONVERSATION = await page.evaluate(() => {
    const a = document.querySelector('a[href^="/app/messages/"]');
    return a ? new URL(a.href).pathname : null;
  });
  await page.close();
  return paths;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const report = [];
  let problems = 0;

  // One authenticated context per role, reused across viewports so sign-in
  // happens three times in total rather than once per screenshot.
  const roles = ["owner", "finance", "staff"].filter((r) => !ONLY_ROLE || r === ONLY_ROLE);
  const viewports = VIEWPORTS.filter((v) => !ONLY_VIEWPORT || v.name === ONLY_VIEWPORT);

  for (const vp of viewports) {
    const contexts = {};
    for (const role of roles) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        bypassCSP: true, // for the harness's own measurement script only
      });
      await signIn(ctx, `fixture.${role}`);
      contexts[role] = ctx;
    }

    const dynamic = await resolveDynamicPaths(contexts.owner ?? Object.values(contexts)[0]);

    for (const screen of SCREENS) {
      const ctx = contexts[screen.role] ?? contexts.owner ?? Object.values(contexts)[0];
      if (!ctx) continue;
      const path = dynamic[screen.path] ?? screen.path;
      if (!path || path.startsWith("TASK_") || path.startsWith("PROJECT_") || path === "CONVERSATION") {
        console.log(`- ${screen.name} @ ${vp.name}: no fixture record to open — skipped`);
        report.push({ screen: screen.name, viewport: vp.name, skipped: "no fixture record" });
        continue;
      }

      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text();
        if (t.includes("react-refresh") || t.includes("unsafe-eval")) return;
        if (t.includes("favicon")) return;
        consoleErrors.push(t.slice(0, 180));
      });

      try {
        const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(350);
        const audit = await page.evaluate(AUDIT);
        const status = res?.status() ?? 0;
        const redirected = new URL(page.url()).pathname !== path;

        await page.screenshot({ path: join(OUT, `${screen.name}--${vp.name}.png`), fullPage: false });
        if (vp.name === "desktop-lg") {
          await page.screenshot({ path: join(OUT, `${screen.name}--full.png`), fullPage: true });
        }

        const bad =
          audit.overflow > 0 || consoleErrors.length > 0 || status >= 400 || redirected || !audit.hasRail;
        if (bad) problems++;
        report.push({
          screen: screen.name, title: screen.title, role: screen.role, path,
          viewport: vp.name, status, redirected, headline: audit.headline,
          overflowPx: audit.overflow, smallTargets: audit.smallCount, smallSamples: audit.small,
          tinyText: audit.tinyCount, tinySamples: audit.tiny,
          fixtureMarkers: audit.fixtureMarkers, consoleErrors,
        });
        console.log(
          `${bad ? "✗" : "✓"} ${screen.name.padEnd(22)} @ ${vp.name.padEnd(11)} ` +
            `status ${status} overflow ${audit.overflow}px targets ${audit.smallCount} tiny ${audit.tinyCount}` +
            `${redirected ? " REDIRECTED" : ""} — "${audit.headline}"`,
        );
      } catch (err) {
        problems++;
        report.push({ screen: screen.name, viewport: vp.name, error: String(err.message ?? err) });
        console.error(`✗ ${screen.name} @ ${vp.name}: ${err.message}`);
      } finally {
        await page.close();
      }
    }

    for (const ctx of Object.values(contexts)) await ctx.close();
  }

  // Reduced motion, on the signature screen, as a first-class rendering mode.
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      bypassCSP: true,
    });
    await signIn(ctx, "fixture.owner");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app/command`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, "01-command-centre--reduced-motion.png") });
    console.log("✓ 01-command-centre @ reduced-motion");
    await ctx.close();
  }

  await browser.close();
  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));

  const overflows = report.filter((r) => (r.overflowPx ?? 0) > 0);
  console.log(`\n${report.length} captures → ${OUT}`);
  console.log(`Horizontal overflow: ${overflows.length === 0 ? "none" : overflows.map((r) => `${r.screen}@${r.viewport}`).join(", ")}`);
  if (problems > 0) {
    console.error(`\n${problems} capture(s) reported a problem — see report.json`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
