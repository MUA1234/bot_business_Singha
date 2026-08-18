#!/usr/bin/env node
/**
 * Browser check for the inbound review queue and the Analyze screen.
 *
 * WHAT THIS CAN AND CANNOT DO, stated plainly. The application reaches its database through
 * Supabase's HTTP API, and there is no Supabase instance in this container — so no browser check
 * here can sign in, load a queue, or run an analysis. What it CAN establish, in a real browser
 * rendering the real production build, is:
 *
 *   * the routes exist and are served (not a 404 from a page that was never wired);
 *   * an unauthenticated visitor is sent to sign in rather than shown either screen;
 *   * the pages render without a client-side crash.
 *
 * What each screen SAYS with data in it is asserted by rendering the components directly —
 * tests/campaign/ui-rendered-truthfulness.test.ts. Neither check is sufficient alone.
 *
 * Uses the pre-installed Chromium via --dump-dom, so it adds no dependency.
 *
 * Usage: node scripts/verify/browser-check.mjs [--port 3999]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
].find((p) => existsSync(p));

const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 3999;
const BASE = `http://127.0.0.1:${PORT}`;

if (!CHROME) {
  console.error("❌ browser-check: no Chromium binary found under /opt/pw-browsers");
  process.exit(1);
}

/** Placeholder configuration: enough for the server to boot, never a real credential. */
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1/unused",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "browser-check-placeholder",
  SUPABASE_SERVICE_ROLE_KEY: "browser-check-placeholder",
  WHATSAPP_VERIFY_TOKEN: "browser-check-placeholder",
  WHATSAPP_APP_SECRET: "browser-check-placeholder",
};

const server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

const stop = () => { try { server.kill("SIGTERM"); } catch { /* noop */ } };
process.on("exit", stop);

async function waitForServer(timeoutMs = 60_000) {
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

const dom = (url) =>
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=5000", "--dump-dom", url,
    // Chromium logs a wall of dbus/UPower errors in a container with no session bus. They are
    // environmental noise, not page failures, and they drown the actual result.
  ], { encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  if (!(await waitForServer())) {
    console.error("❌ browser-check: the server did not start\n" + serverLog.slice(-2000));
    process.exit(1);
  }

  // 1. Both screens exist and REDIRECT an unauthenticated visitor rather than rendering.
  for (const path of ["/app/admin/inbound-review", "/app/command/analyze"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    check(
      `${path} is served and gated`,
      res.status !== 404 && (res.status === 307 || res.status === 302 || location.includes("/login")),
      `status ${res.status}${location ? ` → ${location}` : ""}`,
    );
  }

  // 2. The sign-in page renders in a real browser, with no crash banner.
  const loginDom = dom(`${BASE}/login`);
  check("/login renders in Chromium", loginDom.includes("<form") && !/Application error/i.test(loginDom),
    `${loginDom.length} bytes of DOM`);

  // 3. The landing page renders (it is the only data-free page).
  const homeDom = dom(`${BASE}/`);
  check("/ renders in Chromium", homeDom.length > 500 && !/Application error/i.test(homeDom),
    `${homeDom.length} bytes of DOM`);

  console.log(
    "\nNOTE: signed-in screens are NOT exercised here — there is no Supabase instance in this " +
    "container, so no browser check can load the queue or run an analysis. What those screens say " +
    "with data in them is asserted by rendering the components in " +
    "tests/campaign/ui-rendered-truthfulness.test.ts.",
  );
} finally {
  stop();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n❌ browser-check FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("\n✅ browser-check: routes served, gated, and rendering.");
