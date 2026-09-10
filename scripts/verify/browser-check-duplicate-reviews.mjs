#!/usr/bin/env node
/**
 * OF-016 browser check — the duplicate-review queue in a REAL browser, at three real viewports.
 *
 * WHAT THIS CAN AND CANNOT DO, stated plainly, because the limit is real and permanent in this
 * container. The application reaches its database through Supabase's HTTP API and there is no
 * Supabase instance here, so NO browser check can sign in and load the queue with data in it.
 * Claiming otherwise would be the kind of untrue verification this repository keeps correcting.
 *
 * What this DOES establish, in Chromium, at 390 / 768 / 1440:
 *   * the route exists and is served — not a 404 from a page that was never wired up;
 *   * an unauthenticated visitor is REDIRECTED to sign in rather than shown a paused payment;
 *   * every rendered page lays out without horizontal overflow at that width (measured in the
 *     browser: `documentElement.scrollWidth <= innerWidth + 1`);
 *   * no client-side crash and no console error at any width.
 *
 * What the screen SAYS once it has rows is asserted where it can be asserted honestly: the
 * components are rendered against rows the REAL `resolve_duplicate_review` RPC wrote on a live
 * PostgreSQL, in tests/integration/of016-rendered-matches-persisted.test.tsx. Neither check is
 * sufficient on its own; together they cover layout and truthfulness.
 *
 * Usage: node scripts/verify/browser-check-duplicate-reviews.mjs [--port 3998]
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CHROME = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
].find((p) => existsSync(p));

const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  { name: "mobile 390", width: 390, height: 844 },
  { name: "tablet 768", width: 768, height: 1024 },
  { name: "desktop 1440", width: 1440, height: 900 },
];

/** Placeholder configuration: enough for the server to boot, never a real credential. */
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1/unused",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "bc-none",
  SUPABASE_SERVICE_ROLE_KEY: "bc-none",
  WHATSAPP_VERIFY_TOKEN: "bc-none",
  WHATSAPP_APP_SECRET: "bc-none",
  CRON_SECRET: "bc-none",
};

const nextCli = resolve("node_modules", "next", "dist", "bin", "next");
const server = spawn(process.execPath, [nextCli, "start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });
const stop = () => { try { server.kill("SIGTERM"); } catch { /* noop */ } };
process.on("exit", stop);

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

/** Give Next's link prefetches time to finish, so navigating away does not cancel them. */
const settlePrefetches = async (page) => { await page.waitForTimeout(1200); };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** The routes OF-016 adds or changes, plus the pages a reviewer reaches them from. */
const GATED = [
  "/app/finance/duplicate-reviews",
  "/app/finance/approvals",
  "/app/finance",
  "/app/admin/health",
];
/** The pages that actually render for an unauthenticated visitor — the only ones layout can be measured on. */
const PUBLIC = ["/", "/login"];

try {
  if (!(await waitForServer())) {
    console.error("❌ browser-check: the server did not start\n" + serverLog.slice(-2000));
    process.exit(1);
  }

  // 1. Every OF-016 route is served and gated. A paused payment must never render to a stranger.
  for (const path of GATED) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    check(
      `${path} is served and gated`,
      res.status !== 404 && (res.status === 307 || res.status === 302 || location.includes("/login")),
      `status ${res.status}${location ? ` → ${location}` : ""}`,
    );
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        // Chromium surfaces the aborted prefetch below as a bare "Failed to load resource" line
        // with no URL attached, so it cannot be classified here. The request-level handler is the
        // authoritative one — it sees the URL and the reason.
        if (/^Failed to load resource/.test(m.text())) return;
        consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => consoleErrors.push(String(e)));
      // An ABORTED RSC prefetch is not a page defect. Next prefetches the payload of every visible
      // link; the browser cancels those still in flight when the page navigates or the context
      // closes, and reports `net::ERR_ABORTED`. Verified independently with a probe that lets every
      // prefetch finish: NO request returns 4xx at any viewport. Only this exact shape — aborted,
      // and a `_rsc` prefetch — is ignored; every other failed request, and every response of 400
      // or worse, still fails this check.
      // An ABORTED request is one the BROWSER chose not to finish, not a page defect. Two shapes
      // occur here and both were verified to be healthy when requested directly:
      //   * `…?_rsc=…` — Next prefetches the payload of every visible link; the browser cancels
      //     those in flight when the page navigates or the context closes. Requested directly with
      //     an `RSC: 1` header, /login?_rsc=… returns 200.
      //   * `/media/*.mp4` — the landing page's background video, which only the mobile viewport
      //     requests. Cancelled the same way at teardown. Requested directly it returns 200 with
      //     its full 200,234 bytes, so the asset is present and served.
      // Nothing else is ignored: every other failed request, and EVERY response of 400 or worse,
      // still fails this check.
      const abortedByTeardown = (u) => /[?&]_rsc=/.test(u) || /\.(mp4|webm)(\?|$)/.test(u);
      page.on("requestfailed", (r) => {
        const why = r.failure()?.errorText ?? "";
        if (why === "net::ERR_ABORTED" && abortedByTeardown(r.url())) return;
        consoleErrors.push(`requestfailed ${r.url()} ${why}`);
      });
      page.on("response", (r) => { if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`); });

      for (const path of PUBLIC) {
        await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 });
        // Next prefetches the RSC payload of every visible link. Navigating the instant the page
        // reports idle CANCELS those in flight, and Chromium reports the cancellation as a failed
        // request and a console 404 — a defect of the CHECK, not of the page. Let them finish, so
        // what follows measures the page rather than the race. (Verified: with prefetches settled,
        // no request 4xxs at any viewport.)
        await settlePrefetches(page);
        const body = await page.textContent("body");
        check(`${path} renders at ${vp.name}`,
          !!body && body.length > 50 && !/Application error/i.test(body), `${body?.length ?? 0} chars`);

        // Measured in the browser, not assumed from CSS. Horizontal overflow is the defect that
        // only shows up at a real width.
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        check(`${path} has no horizontal overflow at ${vp.name}`,
          overflow.scrollWidth <= overflow.innerWidth + 1,
          `scrollWidth ${overflow.scrollWidth} vs innerWidth ${overflow.innerWidth}`);
      }

      // 2. A signed-out visitor asking for the queue lands on sign-in, in the browser, at this width.
      await page.goto(`${BASE}/app/finance/duplicate-reviews`, { waitUntil: "networkidle", timeout: 30_000 });
      await settlePrefetches(page);
      const url = page.url();
      const text = (await page.textContent("body")) ?? "";
      check(`the duplicate-review queue is not shown to a signed-out visitor at ${vp.name}`,
        /\/login/.test(url) && !/Suspected duplicate/i.test(text), `landed on ${url}`);

      check(`no console errors at ${vp.name}`, consoleErrors.length === 0,
        consoleErrors.slice(0, 2).join(" | ") || "none");
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  console.log(
    "\nNOTE: the queue WITH ROWS IN IT is not exercised here — there is no Supabase instance in " +
    "this container, so no browser check can sign in and load it. That the screen's words match " +
    "what the RPC actually persisted is asserted against a disposable local PostgreSQL in " +
    "tests/integration/of016-rendered-matches-persisted.test.tsx.",
  );
} finally {
  stop();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n❌ browser-check: ${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ browser-check: ${results.length} checks passed across ${VIEWPORTS.length} viewports`);
// EXIT EXPLICITLY. `stop()` sends SIGTERM but the spawned `next start` keeps node's event loop
// alive for a while afterwards, so on the success path the process printed its summary and then
// sat there. Piped into anything (`| tail`), or wrapped in `timeout`, that reads as a HANG and
// then as a failure — a green run reported as a broken one. The failure path already exited; this
// makes the success path do the same.
process.exit(0);
