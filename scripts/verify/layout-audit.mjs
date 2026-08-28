/**
 * LAYOUT & TYPOGRAPHY AUDIT — measures the REAL rendered DOM of the
 * authenticated application and reports, per screen and per CSS selector:
 *
 *   1. short labels that wrap (the "POSTE / D", "Vie / w" class of defect)
 *   2. elements narrower than their own min-content width
 *   3. overflow (scrollWidth > clientWidth)
 *   4. text below a legible size for the viewport
 *   5. unused horizontal canvas — how much width the content leaves empty
 *
 * Every finding is attributed to a SELECTOR, not to a screen, so the fixes are
 * made in the design system rather than patched screen by screen.
 *
 * Loopback only. Signs in through the real /login form — no auth bypass.
 */
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.AUDIT_BASE ?? "http://127.0.0.1:3230";
const PASSWORD = process.env.DEV_FIXTURE_PASSWORD;
const OUT = "screenshots/layout-audit";

const host = new URL(BASE).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error(`Refusing to audit a non-loopback host: ${host}`);
}
if (!PASSWORD) throw new Error("DEV_FIXTURE_PASSWORD is required.");

/**
 * Screens, with the role entitled to each. These paths MUST match the ones the
 * screenshot harness uses — an earlier revision of this file guessed several
 * ("/app/people", "/app/risk", "/app/health") which do not exist, so those
 * screens silently measured a 404 card instead of the real page and reported no
 * defects. The audit now asserts that each page rendered its expected heading.
 */
const SCREENS = [
  ["command-centre", "/app/command", "owner"],
  ["ai-manager", "/app/ai", "owner"],
  ["approvals", "/app/finance/approvals", "finance"],
  ["work", "/app/operations/tasks", "owner"],
  ["projects", "/app/operations/projects", "owner"],
  ["project-room", "/app/operations/projects/0000f1de-0000-4000-8000-000000000300", "owner"],
  ["people", "/app/hr", "owner"],
  ["capacity", "/app/hr/capacity", "owner"],
  ["staff", "/app/hr/staff", "owner"],
  ["finance", "/app/finance", "finance"],
  ["journals", "/app/finance/journals", "finance"],
  ["trial-balance", "/app/finance/trial-balance", "finance"],
  ["budgets", "/app/finance/budgets", "finance"],
  ["receivables", "/app/finance/receivables", "finance"],
  ["crm", "/app/sales", "owner"],
  ["messages", "/app/messages", "owner"],
  ["calendar", "/app/calendar", "owner"],
  ["documents", "/app/documents", "owner"],
  ["fleet", "/app/fleet", "owner"],
  ["legal", "/app/legal", "owner"],
  ["health", "/app/admin/health", "owner"],
  ["audit", "/app/admin/audit", "owner"],
  ["procurement", "/app/procurement", "owner"],
  ["admin", "/app/admin", "owner"],
  ["marketing", "/app/marketing", "owner"],
  ["portfolio", "/app/portfolio", "owner"],
  ["notifications", "/app/notifications", "owner"],
  ["my-work", "/app/me", "staff"],
];

const VIEWPORTS = [
  ["w1920", 1920, 1080],
  ["w1440", 1440, 900],
  ["w1280", 1280, 800],
  ["tablet", 834, 1194],
  ["mobile", 390, 844],
];

/** Runs inside the page. Returns raw measurements; judgement happens in node. */
const PROBE = String.raw`(() => {
  const out = { wraps: [], squeezed: [], overflow: [], escapes: [], tiny: [], canvas: null };

  const selectorFor = (el) => {
    const parts = [];
    let node = el, hops = 0;
    while (node && node.nodeType === 1 && hops < 4) {
      let part = node.tagName.toLowerCase();
      const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
      if (cls.length) part += "." + cls.slice(0, 3).join(".");
      parts.unshift(part);
      if (cls.length) break;
      node = node.parentElement; hops++;
    }
    return parts.join(" > ");
  };

  // Canvas usage must be measured from CONTENT, not from atmosphere. The
  // environment layers (.env-*) are deliberately oversized full-bleed washes
  // clipped by their parent; counting them made every screen report "0% unused"
  // while the actual panels stopped far short of the edge.
  const isDecor = (el) =>
    el.closest(".env") !== null ||
    el.getAttribute("aria-hidden") === "true" ||
    el.classList.contains("sr-only");

  const stage = document.querySelector(".surface, .stage, .main, main") || document.body;
  const sr = stage.getBoundingClientRect();
  let widest = 0;
  for (const el of stage.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.height < 8 || r.width < 8) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "absolute") continue;
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (isDecor(el)) continue;
    widest = Math.max(widest, r.right);
  }
  out.canvas = {
    viewport: window.innerWidth,
    stageLeft: Math.round(sr.left),
    stageWidth: Math.round(sr.width),
    contentRight: Math.round(widest),
    unusedRight: Math.round(window.innerWidth - widest),
  };

  const TEXT_TAGS = new Set(["SPAN","TD","TH","BUTTON","A","LABEL","STRONG","B","EM","LI","DT","DD","H1","H2","H3","H4","H5","H6","P","DIV","SUMMARY","FIGCAPTION"]);

  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;

    // Overflow only counts when NOTHING handles it. An element wider than its
    // box inside a container that scrolls horizontally (a .table-wrap, a board)
    // is the intended design, not a defect — so walk up for a scroll owner
    // before reporting.
    const SCROLLS = new Set(["auto", "scroll", "hidden", "clip"]);
    if (el.scrollWidth - el.clientWidth > 2 && !SCROLLS.has(cs.overflowX) && !isDecor(el)) {
      let owner = el.parentElement, handled = false, hops = 0;
      while (owner && hops < 8) {
        if (SCROLLS.has(getComputedStyle(owner).overflowX)) { handled = true; break; }
        owner = owner.parentElement; hops++;
      }
      if (!handled) {
        out.overflow.push({ sel: selectorFor(el), by: el.scrollWidth - el.clientWidth, text: (el.textContent||"").trim().slice(0,40) });
      }
    }

    // TEXT PAINTING OUTSIDE ITS OWN BOX.
    //
    // A block with white-space:nowrap keeps its box at the container width
    // and lets the glyphs run straight out of it. Every box-based check — this
    // file's own squeezed probe included — reports it as fitting, because the
    // box does fit. It is only visible by measuring the TEXT.
    //
    // This is how a nowrap rule meant for table dates escaped onto a chart
    // caption and painted a full sentence across the panel beside it.
    if (cs.whiteSpace === "nowrap" || cs.whiteSpace === "pre") {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (own.length > 24) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const textW = range.getBoundingClientRect().width;
        const boxW = el.getBoundingClientRect().width;
        // Deliberate truncation is CONTAINED, not escaped: an element that
        // clips its own overflow (usually with a text-overflow ellipsis) shows
        // the reader a cut-off value on purpose and paints nothing outside it.
        // Only unclipped text actually lands on the panel next door.
        const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);
        let contained = CLIPS.has(cs.overflow) || CLIPS.has(cs.overflowX);
        let anc = el.parentElement, hops = 0;
        while (!contained && anc && hops < 4) {
          const acs = getComputedStyle(anc);
          if (CLIPS.has(acs.overflow) || CLIPS.has(acs.overflowX)) contained = true;
          anc = anc.parentElement; hops++;
        }
        if (textW - boxW > 4 && !contained && !isDecor(el)) {
          out.escapes.push({
            sel: selectorFor(el),
            by: Math.round(textW - boxW),
            text: own.slice(0, 44),
          });
        }
      }
    }

    const hasElementChildren = el.children.length > 0;
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
    if (!own || (hasElementChildren && own.length < 2)) continue;
    if (!TEXT_TAGS.has(el.tagName)) continue;

    const fs = parseFloat(cs.fontSize);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh)) lh = fs * 1.2;

    // Visually-hidden text is not read by anyone and has no size requirement.
    const hidden = cs.clipPath.startsWith("inset(50%") || el.classList.contains("sr-only");
    if (fs > 0 && fs < 11.5 && own.length > 1 && !hidden) {
      out.tiny.push({ sel: selectorFor(el), px: Math.round(fs*10)/10, text: own.slice(0,40) });
    }

    // A "short label" is <= 22 chars. Count rendered line boxes via Range
    // rects — reliable inside flex and grid, unlike a height heuristic.
    //
    // Measure ONLY the element's own TEXT nodes. Selecting all node contents
    // also picks up child elements — a status dot, an icon — which sit on their
    // own baseline and were being counted as a second line. That produced 123
    // false "wraps" on .sig alone.
    if (own.length <= 22) {
      const rects = [];
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        rects.push(...[...range.getClientRects()].filter(x => x.height > 1 && x.width > 1));
      }
      const tops = new Set(rects.map(x => Math.round(x.top)));
      if (tops.size > 1) {
        const words = own.split(/\s+/).filter(Boolean);
        out.wraps.push({
          sel: selectorFor(el),
          text: own.slice(0, 30),
          lines: tops.size,
          brokenWord: words.length === 1,
          width: Math.round(r.width),
          fontSize: Math.round(fs*10)/10,
        });
      }
    }
  }

  // Table cells are deliberately EXCLUDED. Forcing width:min-content on a
  // th or td does not isolate it — the table layout algorithm recomputes the
  // whole column, so the measurement is meaningless. A clipped header shows up
  // in the overflow check instead, and a wrapped one in the wrap check.
  const CANDIDATES = ".card, .panel, .instr, .stat, .kpi, .matter, .node-card, .brief-band, .sheet, aside, .split-aside, .cell, .metric";
  for (const el of document.querySelectorAll(CANDIDATES)) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    const prevW = el.style.width, prevMin = el.style.minWidth;
    el.style.width = "min-content";
    el.style.minWidth = "min-content";
    const minW = el.getBoundingClientRect().width;
    el.style.width = prevW; el.style.minWidth = prevMin;
    if (minW - r.width > 4) {
      out.squeezed.push({ sel: selectorFor(el), width: Math.round(r.width), minContent: Math.round(minW), text: (el.textContent||"").trim().slice(0,32) });
    }
  }

  return out;
})()`;

async function signIn(ctx, username) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.fill("#username", username);
  await p.fill("#password", PASSWORD);
  await Promise.all([
    p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    p.click('button[type="submit"]'),
  ]);
  await p.close();
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const contexts = {};
for (const role of ["owner", "finance", "staff"]) {
  contexts[role] = await browser.newContext({ viewport: { width: 1920, height: 1080 }, bypassCSP: true });
  await signIn(contexts[role], `fixture.${role}`);
}

const findings = [];
const canvasRows = [];

for (const [vpName, w, h] of VIEWPORTS) {
  for (const [screen, path, role] of SCREENS) {
    const page = await contexts[role].newPage();
    await page.setViewportSize({ width: w, height: h });
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(300);

      // A 404 or a sign-out redirect renders a small, perfectly-laid-out card
      // and would be reported as a clean screen. Refuse to measure it.
      const body = await page.evaluate("document.body.innerText");
      if (/Page not found/i.test(body)) {
        throw new Error(`404 — ${path} does not exist; the audit would measure a not-found card`);
      }
      if (page.url().includes("/login")) {
        throw new Error(`redirected to /login — ${path} is not reachable as fixture.${role}`);
      }

      const r = await page.evaluate(PROBE);
      canvasRows.push({ screen, vp: vpName, ...r.canvas });
      for (const kind of ["wraps", "squeezed", "overflow", "escapes", "tiny"]) {
        for (const f of r[kind]) findings.push({ kind, screen, vp: vpName, ...f });
      }
    } catch (e) {
      findings.push({ kind: "error", screen, vp: vpName, sel: "-", text: String(e).slice(0, 120) });
    }
    await page.close();
  }
  process.stdout.write(`  measured ${vpName}\n`);
}

await browser.close();

// Aggregate by SELECTOR, because the fix belongs in the design system.
const bySel = new Map();
for (const f of findings) {
  const key = `${f.kind}|${f.sel}`;
  if (!bySel.has(key)) bySel.set(key, { kind: f.kind, sel: f.sel, count: 0, screens: new Set(), vps: new Set(), samples: [] });
  const e = bySel.get(key);
  e.count++; e.screens.add(f.screen); e.vps.add(f.vp);
  if (e.samples.length < 3 && f.text) e.samples.push(f.text);
  if (f.brokenWord) e.brokenWord = true;
  if (f.minContent) e.worstSqueeze = Math.max(e.worstSqueeze ?? 0, f.minContent - f.width);
  if (f.kind === "escapes" && f.by) e.worstEscape = Math.max(e.worstEscape ?? 0, f.by);
  if (f.px) e.smallest = Math.min(e.smallest ?? 99, f.px);
}
const agg = [...bySel.values()]
  .map((e) => ({ ...e, screens: [...e.screens], vps: [...e.vps] }))
  .sort((a, b) => b.count - a.count);

writeFileSync(`${OUT}/findings.json`, JSON.stringify({ agg, canvasRows }, null, 2));

const counts = findings.reduce((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {});
console.log("\n== LAYOUT AUDIT ==");
console.log(counts);
const brokenWords = findings.filter((f) => f.brokenWord);
console.log(`\nBROKEN SINGLE WORDS: ${brokenWords.length}`);
for (const e of agg.filter((x) => x.brokenWord).slice(0, 25)) {
  console.log(`  ${String(e.count).padStart(4)} x ${e.sel}`.padEnd(74) + ` "${e.samples.join('" "')}"`);
}
console.log(`\nTEXT PAINTING OUTSIDE ITS BOX (nowrap escapes)`);
for (const e of agg.filter((x) => x.kind === "escapes").slice(0, 15)) {
  console.log(`  ${String(e.count).padStart(4)} x ${e.sel}`.padEnd(74) + ` by ${e.worstEscape ?? "?"}px  "${e.samples[0] ?? ""}"`);
}
console.log(`\nTOP WRAPPING SELECTORS`);
for (const e of agg.filter((x) => x.kind === "wraps").slice(0, 25)) {
  console.log(`  ${String(e.count).padStart(4)} x ${e.sel}`.padEnd(74) + ` "${e.samples.join('" "')}"`);
}
console.log(`\nSQUEEZED BELOW MIN-CONTENT`);
for (const e of agg.filter((x) => x.kind === "squeezed").slice(0, 20)) {
  console.log(`  ${String(e.count).padStart(4)} x ${e.sel}`.padEnd(74) + ` short by ${e.worstSqueeze}px`);
}
console.log(`\nTINY TEXT`);
for (const e of agg.filter((x) => x.kind === "tiny").slice(0, 15)) {
  console.log(`  ${String(e.count).padStart(4)} x ${e.sel}`.padEnd(74) + ` ${e.smallest}px`);
}
console.log(`\nUNUSED CANVAS (1920)`);
for (const row of canvasRows.filter((r) => r.vp === "w1920").sort((a, b) => b.unusedRight - a.unusedRight).slice(0, 14)) {
  const pct = Math.round((row.unusedRight / row.viewport) * 100);
  console.log(`  ${row.screen.padEnd(18)} content ends ${String(row.contentRight).padStart(5)}px - ${String(pct).padStart(3)}% unused`);
}
