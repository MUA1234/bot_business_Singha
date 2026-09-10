/**
 * TEXT SHARPNESS MEASUREMENT.
 *
 * Renders the same text region under several CSS variants and measures how
 * sharp the glyph edges actually are, so a claim about blur is settled by
 * pixels rather than by opinion.
 *
 * Metric: mean absolute horizontal gradient across the crop, plus the share of
 * pixels sitting in the mid-tones between background and text. Sharp text has a
 * high gradient and FEW mid-tone pixels — the edge transitions in one or two
 * pixels. Blurred or resampled text spreads each edge over several pixels,
 * which lowers the peak gradient and raises the mid-tone share.
 *
 * Captured at deviceScaleFactor 1, because that is where compositing artefacts
 * appear; at 2x or 3x Playwright re-renders and can hide them.
 *
 * Loopback only. Signs in through the real /login form — no auth bypass.
 */
import { chromium } from "playwright-core";
import { inflateSync } from "node:zlib";

const BASE = process.env.AUDIT_BASE ?? "http://127.0.0.1:3230";
const PASSWORD = process.env.DEV_FIXTURE_PASSWORD;
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(BASE).hostname)) {
  throw new Error("Refusing to run against a non-loopback host.");
}
if (!PASSWORD) throw new Error("DEV_FIXTURE_PASSWORD is required.");

/** Minimal PNG reader: 8-bit RGB/RGBA, no interlace — what Chromium emits. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced png unsupported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error(`colour type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec 9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Luminance plane. */
function luma({ width, height, channels, data }) {
  const g = new Float64Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += channels) {
    g[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return g;
}

function sharpness(img) {
  const { width, height } = img;
  const g = luma(img);
  let gradSum = 0, gradCount = 0, peak = 0;
  const hist = new Array(256).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const d = Math.abs(g[y * width + x] - g[y * width + x - 1]);
      gradSum += d; gradCount++;
      if (d > peak) peak = d;
    }
  }
  for (let i = 0; i < g.length; i++) hist[Math.round(g[i])]++;

  // Background and text tones are the two extremes present in the crop.
  let lo = 0, hi = 255;
  while (lo < 255 && hist[lo] === 0) lo++;
  while (hi > 0 && hist[hi] === 0) hi--;
  const span = hi - lo;
  // Mid-tones: pixels in the middle 40% of the range — the edge ramp.
  let mid = 0, total = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    if (i > lo + span * 0.3 && i < hi - span * 0.3) mid += hist[i];
  }
  return {
    meanGradient: +(gradSum / gradCount).toFixed(3),
    peakGradient: +peak.toFixed(1),
    midToneShare: +((mid / total) * 100).toFixed(2),
    range: span,
  };
}

const VARIANTS = {
  "A · current (Variable Display)": "",
  "B · Segoe UI Variable Text": "html,body,*{font-family:'Segoe UI Variable Text','Segoe UI',Arial,sans-serif!important}",
  "C · plain Segoe UI": "html,body,*{font-family:'Segoe UI',Arial,sans-serif!important}",
  "D · Arial": "html,body,*{font-family:Arial,sans-serif!important}",
  "E · current + weight 500": "body,p,span,div,td{font-weight:500!important}",
  "F · Variable Text + weight 450": "html,body,*{font-family:'Segoe UI Variable Text','Segoe UI',Arial,sans-serif!important}body,p,span,div,td{font-weight:450!important}",
  "G · text-muted brighter only": ":root{--text-muted:#e8e3db!important}",
};

const browser = await chromium.launch();
// deviceScaleFactor 1 — compositing artefacts are invisible at 2x.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, bypassCSP: true, serviceWorkers: "block" });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.fill("#username", "fixture.owner");
await page.fill("#password", PASSWORD);
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith("/login")),
  page.click('button[type="submit"]'),
]);
await page.goto(`${BASE}/app/command`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

// A fixed crop over body text that exists in every variant.
const clip = await page.evaluate(`(() => {
  const el = [...document.querySelectorAll("*")].find(
    (n) => n.children.length === 0 && /payment decision from someone/.test(n.textContent || "")
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top) - 2, width: Math.min(460, Math.round(r.width)), height: Math.round(r.height) + 4 };
})()`);
if (!clip) throw new Error("could not find the sample text");

console.log(`crop ${clip.width}x${clip.height} @ (${clip.x},${clip.y})  deviceScaleFactor=1\n`);
console.log("variant".padEnd(30) + "meanGrad  peakGrad  midTone%  (higher grad + lower midtone = sharper)");

for (const [name, css] of Object.entries(VARIANTS)) {
  await page.evaluate(`(() => {
    document.getElementById("__sharp")?.remove();
    if (${JSON.stringify(css)}) {
      const s = document.createElement("style"); s.id = "__sharp"; s.textContent = ${JSON.stringify(css)};
      document.head.appendChild(s);
    }
  })()`);
  await page.waitForTimeout(500);
  const buf = await page.screenshot({ clip });
  const m = sharpness(decodePng(buf));
  console.log(
    name.padEnd(30) +
      String(m.meanGradient).padStart(8) +
      String(m.peakGradient).padStart(10) +
      String(m.midToneShare).padStart(10),
  );
}

await browser.close();
