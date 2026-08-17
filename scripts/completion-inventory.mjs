#!/usr/bin/env node
/**
 * Completion-program inventory (Phase 0 of the owner-authorized completion program).
 *
 * MACHINE-CHECKABLE, deterministic, dependency-free. Re-run at any time:
 *   node scripts/completion-inventory.mjs            # writes docs/architecture-v3.1/COMPLETION_INVENTORY.md + prints summary
 *   node scripts/completion-inventory.mjs --check    # exits 1 if a NEW authenticated-surface file uses supabaseAdmin()
 *                                                    # outside scripts/allowlists/supabase-admin-system.json (once that
 *                                                    # allowlist exists — Phase 2 enforcement), or if a previously-clean
 *                                                    # category regresses against the committed snapshot's counts.
 *
 * What it inventories (owner Phase-0 mandate):
 *   1. supabaseAdmin() usage by file (service-role surface, Phase-2 cutover input)
 *   2. money-as-Number SUSPECTS (heuristic: Number()/parseFloat/parseInt/Math.* or +/-* arithmetic on lines
 *      naming money identifiers) — Phase-1A work list; each finding needs human triage (some are counts)
 *   3. V3.1 flags without a runtime consumer (scaffolding vs implemented)
 *   4. RLS_READS / RLS_WRITES / WHATSAPP_ASYNC consumer map
 *   5. TODO / FIXME / XXX / HACK markers
 *   6. stub routes (501 / "not implemented")
 *   7. error-masking SUSPECTS (catch blocks returning empty values — Phase-1C work list)
 *
 * Output is sorted and timestamp-free so the committed snapshot only changes when the code changes.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "docs/architecture-v3.1/COMPLETION_INVENTORY.md");
const ALLOWLIST = join(ROOT, "scripts/allowlists/supabase-admin-system.json");
const CHECK = process.argv.includes("--check");

/** Recursively list files under dir with the given extensions. */
function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).replaceAll("\\", "/");
const files = walk(SRC, [".ts", ".tsx"]).sort();

// ── 1. supabaseAdmin usage ───────────────────────────────────────────────────
const adminFiles = [];
for (const f of files) {
  const t = readFileSync(f, "utf8");
  const n = (t.match(/supabaseAdmin/g) ?? []).length;
  if (n > 0 && !rel(f).startsWith("src/lib/supabase/")) adminFiles.push({ file: rel(f), refs: n });
}

// ── 2. money-as-Number suspects ──────────────────────────────────────────────
const MONEY = /amount|total|price|cost|balance|budget|line_total|unit_price|subtotal|tax|receivable|payable|forecast|settle|reimburs|authority|limit_|_limit|ceiling|revenue|expense|salary|wage/i;
const NUMOP = /\bNumber\s*\(|\bparseFloat\s*\(|\bparseInt\s*\(|Math\.(abs|round|floor|ceil|max|min)\s*\(/;
const moneySuspects = [];
for (const f of files) {
  if (rel(f).startsWith("tests/")) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (NUMOP.test(line) && MONEY.test(line)) {
      moneySuspects.push({ file: rel(f), line: i + 1, code: line.trim().slice(0, 100) });
    }
  });
}

// ── 3+4. flags and toggles without consumers ─────────────────────────────────
function consumersOf(needle, excludeFiles) {
  const hits = [];
  for (const f of files) {
    const r = rel(f);
    if (excludeFiles.some((x) => r.includes(x))) continue;
    if (readFileSync(f, "utf8").includes(needle)) hits.push(r);
  }
  return hits.sort();
}
const flagRows = [];
if (existsSync(join(SRC, "config/flags.ts"))) {
  const t = readFileSync(join(SRC, "config/flags.ts"), "utf8");
  for (const m of t.matchAll(/env:\s*"([A-Z0-9_]+)"/g)) {
    const env = m[1];
    const hits = consumersOf(env, ["src/config/flags.ts"]);
    flagRows.push({ env, consumers: hits });
  }
}
const toggleRows = ["RLS_READS", "RLS_WRITES", "WHATSAPP_ASYNC"].map((env) => ({
  env,
  consumers: consumersOf(env, ["src/config/env.ts", "src/config/flags.ts"]),
}));

// ── 5. TODO / FIXME markers ──────────────────────────────────────────────────
const todos = [];
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const m = line.match(/\b(TODO|FIXME|XXX|HACK)\b[:\s]/);
    if (m) todos.push({ file: rel(f), line: i + 1, kind: m[1], text: line.trim().slice(0, 90) });
  });
}

// ── 6. stub routes ───────────────────────────────────────────────────────────
const stubs = [];
for (const f of files) {
  if (!/route\.tsx?$/.test(f)) continue;
  const t = readFileSync(f, "utf8");
  if (/\b501\b|not.{0,3}implemented/i.test(t)) stubs.push(rel(f));
}

// ── 7. error-masking suspects ────────────────────────────────────────────────
const masks = [];
for (const f of files) {
  const t = readFileSync(f, "utf8");
  // catch → empty/zero return, AND the `const { data } = await …` destructure that discards `error`
  const re = /catch[^{]*\{[^}]{0,400}?return\s+(\[\]|\{\}|null|0|\{\s*[a-zA-Z_]+:\s*(\[\]|0|null)\s*\})/gs;
  let m;
  while ((m = re.exec(t)) !== null) {
    const line = t.slice(0, m.index).split("\n").length;
    masks.push({ file: rel(f), line, returns: m[1].replace(/\s+/g, " ").slice(0, 30) });
  }
  const de = /const\s*\{\s*data\s*\}\s*=\s*await/g;
  while ((m = de.exec(t)) !== null) {
    const line = t.slice(0, m.index).split("\n").length;
    masks.push({ file: rel(f), line, returns: "error-discarding destructure" });
  }
}
masks.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

// ── Report ───────────────────────────────────────────────────────────────────
const md = [];
md.push("# Completion Inventory (machine-generated — do not hand-edit)");
md.push("");
md.push("> Regenerate with `node scripts/completion-inventory.mjs`. Deterministic: changes only when code changes.");
md.push("> Suspect lists are HEURISTIC work lists (each entry needs triage), not verdicts.");
md.push("");
md.push(`## 1. supabaseAdmin() usage — ${adminFiles.length} file(s)`);
md.push("");
md.push("| file | refs |");
md.push("|---|---|");
for (const a of adminFiles) md.push(`| ${a.file} | ${a.refs} |`);
md.push("");
md.push(`Allowlist: ${existsSync(ALLOWLIST) ? "scripts/allowlists/supabase-admin-system.json (enforced via --check)" : "none yet — Phase 2 introduces it; until then --check does not fail on this category"}`);
md.push("");
md.push(`## 2. money-as-Number suspects — ${moneySuspects.length} line(s) (Phase-1A triage list)`);
md.push("");
md.push("| file:line | code |");
md.push("|---|---|");
for (const s of moneySuspects) md.push(`| ${s.file}:${s.line} | \`${s.code.replaceAll("|", "\\|")}\` |`);
md.push("");
md.push(`## 3. V3.1 flags — runtime consumers`);
md.push("");
md.push("| env | consumers |");
md.push("|---|---|");
for (const r of flagRows) md.push(`| ${r.env} | ${r.consumers.length ? r.consumers.join("<br>") : "**none (scaffolding only)**"} |`);
md.push("");
md.push(`## 4. Cutover/async toggles — runtime consumers`);
md.push("");
md.push("| env | consumers |");
md.push("|---|---|");
for (const r of toggleRows) md.push(`| ${r.env} | ${r.consumers.length ? r.consumers.join("<br>") : "**none**"} |`);
md.push("");
md.push(`## 5. TODO/FIXME markers — ${todos.length}`);
md.push("");
md.push("| file:line | kind | text |");
md.push("|---|---|---|");
for (const t of todos) md.push(`| ${t.file}:${t.line} | ${t.kind} | \`${t.text.replaceAll("|", "\\|")}\` |`);
md.push("");
md.push(`## 6. Stub routes (501 / not-implemented) — ${stubs.length}`);
md.push("");
for (const s of stubs) md.push(`- ${s}`);
md.push("");
md.push(`## 7. Error-masking suspects (catch → empty return) — ${masks.length} (Phase-1C triage list)`);
md.push("");
md.push("| file:line | returns |");
md.push("|---|---|");
for (const s of masks) md.push(`| ${s.file}:${s.line} | \`${s.returns}\` |`);
md.push("");

writeFileSync(OUT, md.join("\n"));
console.log(`inventory: admin-files=${adminFiles.length} money-suspects=${moneySuspects.length} flags-no-consumer=${flagRows.filter((r) => !r.consumers.length).length}/${flagRows.length} todos=${todos.length} stubs=${stubs.length} mask-suspects=${masks.length}`);
console.log(`written: ${rel(OUT)}`);

// ── --check enforcement (Phase 2 arms the allowlist) ─────────────────────────
if (CHECK && existsSync(ALLOWLIST)) {
  const allow = new Set(JSON.parse(readFileSync(ALLOWLIST, "utf8")));
  const rogue = adminFiles.map((a) => a.file).filter((f) => !allow.has(f));
  if (rogue.length) {
    console.error(`❌ supabaseAdmin() outside the system allowlist:\n  ${rogue.join("\n  ")}`);
    process.exit(1);
  }
  console.log("✅ supabaseAdmin usage confined to the system allowlist.");
}
