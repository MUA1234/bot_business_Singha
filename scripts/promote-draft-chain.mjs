#!/usr/bin/env node
/**
 * Promote the quarantined R1 draft chain into the numbered Release 1 migration lineage.
 *
 * ── What this does, once ─────────────────────────────────────────────────────────────────────
 *
 * The thirty `R1_DRAFT_NNN_*.up.sql` units become `src/db/migrations/0(110+NNN)_*.sql`, in the
 * same relative order, so `001 → 0111` … `030 → 0140`. Their `.down.sql` counterparts move to
 * `src/db/rollback/`, which is where rollback SQL for the numbered chain lives from now on: the
 * released runner is forward-only and must never see a down file as a migration.
 *
 * The draft directory's SQL is DELETED, not left beside the promotion. Two runnable copies of one
 * migration is how a database ends up with a table created twice under two version numbers, and
 * the whole point of the quarantine was that there was exactly one place to look.
 *
 * ── The banner ───────────────────────────────────────────────────────────────────────────────
 *
 * Every unit opens with `⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases
 * only.` That was true and is now false, and a promoted migration that still says it is a lie
 * the next reader has to discover. It is replaced by a banner naming the original unit, so the
 * provenance survives the renumbering.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────────────────────
 *
 * It does not rewrite in-body cross-references like "(draft 014)" or "unit 023". Those are
 * historically accurate statements about where a thing came from, the owner's instruction is not
 * to mechanically rewrite recorded past numbers, and a global search-and-replace over thirty files
 * of security-sensitive SQL is exactly the kind of edit that changes something nobody intended.
 * `docs/release-1/MIGRATION-PROMOTION.md` carries the mapping so any such reference resolves.
 *
 * It touches nothing under `docs/product-recovery/` or any evidence file.
 *
 * Idempotent: refuses to run twice, because the second run would have nothing to move and a
 * half-applied promotion is worse than none.
 *
 * Usage:  node scripts/promote-draft-chain.mjs [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DRAFT_DIR = "src/db/draft-migrations-r1";
const MIG_DIR = "src/db/migrations";
const ROLLBACK_DIR = "src/db/rollback";
/** The last released migration before promotion. The chain continues from here. */
const BASE = 110;

const dry = process.argv.includes("--dry-run");
const say = (m) => console.log(m);

// ── Inventory ────────────────────────────────────────────────────────────────────────────────
const ups = readdirSync(DRAFT_DIR).filter((f) => /^R1_DRAFT_\d{3}_.*\.up\.sql$/.test(f)).sort();
const downs = readdirSync(DRAFT_DIR).filter((f) => /^R1_DRAFT_\d{3}_.*\.down\.sql$/.test(f)).sort();

if (ups.length === 0) {
  console.error("nothing to promote: no R1_DRAFT_*.up.sql found. Already promoted?");
  process.exit(2);
}
if (ups.length !== downs.length) {
  console.error(`refusing: ${ups.length} up units but ${downs.length} down units`);
  process.exit(2);
}

// Contiguity, from 001, with no gap. A gap would mean the mapping silently shifts a unit.
const numbers = ups.map((f) => Number(f.slice(9, 12)));
for (let i = 0; i < numbers.length; i++) {
  if (numbers[i] !== i + 1) {
    console.error(`refusing: draft chain is not contiguous — expected ${i + 1}, found ${numbers[i]}`);
    process.exit(2);
  }
}

// The released chain must be contiguous up to BASE, or the continuation is not a continuation.
const released = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const high = Number(released[released.length - 1].slice(0, 4));
if (released.length !== BASE || high !== BASE) {
  console.error(`refusing: expected ${BASE} released migrations ending at ${BASE}, found ${released.length} ending at ${high}`);
  process.exit(2);
}

say(`promoting ${ups.length} draft units → ${String(BASE + 1).padStart(4, "0")}–${String(BASE + ups.length).padStart(4, "0")}\n`);

// ── The banner ───────────────────────────────────────────────────────────────────────────────
/**
 * The banner is not one string.
 *
 * Thirty files carry six variants — `R1 DRAFT`, `R1/R2B DRAFT`, `R1/R2C`, `R1/R2S-P`, `R1/R2D`,
 * some with a hyphen where others have an em dash, some followed by one or two lines about the
 * README or owner decision R1-D-1. Matching one exact string and refusing everything else was the
 * first attempt, and it stopped at unit 004.
 *
 * So: consume LEADING comment lines for as long as they are about the quarantine, and stop at the
 * first line that is not. It cannot eat SQL — it only ever consumes `--` comments carrying one of
 * the quarantine markers — and the assertion after the swap catches anything it missed.
 */
const QUARANTINE_LINE = /^--.*(NOT FOR HOSTED APPLICATION|draft-migrations-r1\/README|R1-D-1|PR-F-001)/;

function stripBanner(src) {
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && QUARANTINE_LINE.test(lines[i])) i++;
  if (i === 0) return null;
  // A bare `--` separator immediately after the banner belonged to it.
  if (lines[i] === "--") i++;
  return lines.slice(i).join("\n");
}

function banner(unit, version) {
  return `-- Release 1 — promoted from R1_DRAFT_${unit} on 2026-09-11.
--
-- Quarantined outside the numbered sequence under owner decision R1-D-1 while the hosted
-- migration state was unknown. Case A is proven (the hosted ledger's high-water is main's 0069,
-- recovery markers absent), so the owner approved promotion and this is now migration ${version},
-- applied by the ordinary runner with no special confirmation and no separate ledger.
--
-- In-body references to "draft NNN" name the ORIGINAL unit and were deliberately left alone —
-- see docs/release-1/MIGRATION-PROMOTION.md for the mapping. Rollback SQL for this migration is
-- src/db/rollback/${version}_*.down.sql; the forward runner never sees it.
`;
}

// ── Move ─────────────────────────────────────────────────────────────────────────────────────
if (!dry) mkdirSync(ROLLBACK_DIR, { recursive: true });

const mapping = [];
for (let i = 0; i < ups.length; i++) {
  const up = ups[i];
  const unit = up.slice(9, 12);
  const name = up.slice(13).replace(/\.up\.sql$/, "");
  const version = String(BASE + i + 1).padStart(4, "0");
  const target = `${MIG_DIR}/${version}_${name}.sql`;
  const down = downs.find((d) => d.startsWith(`R1_DRAFT_${unit}_`));
  if (!down) { console.error(`refusing: no down unit for ${up}`); process.exit(2); }
  const rollbackTarget = `${ROLLBACK_DIR}/${version}_${name}.down.sql`;

  const src = readFileSync(`${DRAFT_DIR}/${up}`, "utf8");
  const body = stripBanner(src);
  if (body === null) {
    console.error(`refusing: ${up} does not open with a quarantine banner`);
    process.exit(2);
  }
  const promoted = banner(unit, version) + "--\n" + body;
  if (/NOT FOR HOSTED APPLICATION/.test(promoted)) {
    console.error(`refusing: ${up} still claims NOT FOR HOSTED APPLICATION after the banner swap`);
    process.exit(2);
  }

  const rawDown = readFileSync(`${DRAFT_DIR}/${down}`, "utf8");
  const downBody = stripBanner(rawDown) ?? rawDown;
  const downSrc =
    `-- Rollback for migration ${version} (promoted from R1_DRAFT_${unit}).\n--\n` +
    `-- The forward runner never reads this directory: it is not src/db/migrations, and the\n` +
    `-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database\n` +
    `-- somebody has decided to roll back, in reverse dependency order.\n--\n` + downBody;
  if (/NOT FOR HOSTED APPLICATION/.test(downSrc)) {
    console.error(`refusing: ${down} still claims NOT FOR HOSTED APPLICATION`);
    process.exit(2);
  }

  mapping.push({ unit, version, name, up, down });

  if (dry) { say(`  ${up}  →  ${version}_${name}.sql`); continue; }

  writeFileSync(target, promoted);
  writeFileSync(rollbackTarget, downSrc);
  say(`  ${up}  →  ${version}_${name}.sql`);
}

if (dry) { say("\n(dry run — nothing written)"); process.exit(0); }

// ── Remove the draft SQL. No second runnable copy. ──────────────────────────────────────────
for (const { up, down } of mapping) {
  rmSync(`${DRAFT_DIR}/${up}`);
  rmSync(`${DRAFT_DIR}/${down}`);
}
// Stray editor backups would otherwise be the second copy this exists to prevent.
for (const f of readdirSync(DRAFT_DIR)) {
  if (/\.sql(\.bak)?$/.test(f)) { rmSync(`${DRAFT_DIR}/${f}`); say(`  removed stray ${f}`); }
}

// ── The mapping, for the record ──────────────────────────────────────────────────────────────
writeFileSync("docs/release-1/migration-promotion-map.json", JSON.stringify(
  { promotedOn: "2026-09-11", base: BASE, units: mapping.map(({ unit, version, name }) => ({ unit, version, name })) },
  null, 2) + "\n");

say(`\npromoted ${mapping.length} units. rollback SQL in ${ROLLBACK_DIR}/.`);
say(`draft SQL removed from ${DRAFT_DIR}/ (README kept).`);
if (existsSync(".git")) {
  try { execFileSync("git", ["add", "-A", DRAFT_DIR, MIG_DIR, ROLLBACK_DIR], { stdio: "pipe" }); } catch { /* not fatal */ }
}
