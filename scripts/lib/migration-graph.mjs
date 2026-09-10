/**
 * Migration graph — the shared analysis core behind `migration-inventory` and the
 * base-aware half of `migration-lint`.
 *
 * WHY THIS EXISTS (product-recovery R0). `scripts/migrate.mjs` keys `schema_migrations`
 * on the four-character filename prefix (`f.slice(0, 4)`) and applies only files whose
 * version is not already recorded. Two branches that each define a DIFFERENT migration
 * under the SAME number therefore produce a silent skip: the version is already recorded,
 * so the second branch's file never runs, and every later migration executes against a
 * schema missing its objects. No error is raised. The pre-existing filename lint cannot
 * see this because it inspects one branch in isolation.
 *
 * Everything here is PURE: the entry points take `Array<{filename, content}>` rather than
 * reading git or the filesystem, so the behavioural tests drive them with synthetic
 * migration sets instead of the real 109-file tree.
 *
 * PARSING LIMITS — read before trusting a dependency edge. This is a deliberately
 * conservative regex/scanner pass over DDL, not a PostgreSQL parser. It is designed so
 * that a MISSED edge is possible but a FABRICATED edge is unlikely, and it reports what
 * it could not classify rather than assuming safety. Never treat an empty dependency set
 * as proof that a migration is independent; treat it as "no dependency proven".
 */

import { createHash } from "node:crypto";

// ── Lexical normalisation ────────────────────────────────────────────────────────────

/**
 * Strip SQL comments while respecting string and dollar-quote boundaries.
 *
 * Function bodies are dollar-quoted and are KEPT as code: a body that calls a table or
 * function is a real dependency and dropping bodies would hide most of the graph. Only
 * comments are removed, because migration headers in this repository are long prose that
 * names other migrations ("see migration 0067") and would otherwise fabricate edges.
 */
export function stripComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const two = sql.slice(i, i + 2);

    // Line comment.
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break;
      out += " ";
      i = nl; // keep the newline itself
      continue;
    }

    // Block comment (PostgreSQL nests them).
    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; continue; }
        i++;
      }
      out += " ";
      continue;
    }

    // Single-quoted literal ('' escapes an embedded quote).
    if (sql[i] === "'") {
      out += sql[i++];
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += sql.slice(i, i + 2); i += 2; continue; }
        if (sql[i] === "'") { out += sql[i++]; break; }
        out += sql[i++];
      }
      continue;
    }

    // Double-quoted identifier.
    if (sql[i] === '"') {
      out += sql[i++];
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { out += sql.slice(i, i + 2); i += 2; continue; }
        if (sql[i] === '"') { out += sql[i++]; break; }
        out += sql[i++];
      }
      continue;
    }

    // Dollar quote: $tag$ ... $tag$. Kept verbatim (function bodies are real code).
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) { out += sql.slice(i); break; }
      out += sql.slice(i, end + tag.length);
      i = end + tag.length;
      continue;
    }

    out += sql[i++];
  }

  return out;
}

/** Normalise an object name to `schema.name`, defaulting the schema to `public`. */
function qualify(raw) {
  const name = raw.trim().replace(/"/g, "").replace(/\s+/g, "").toLowerCase();
  if (!name) return null;
  return name.includes(".") ? name : `public.${name}`;
}

/** Bare (unqualified) half of a `schema.name` key. */
function bare(qualified) {
  const dot = qualified.lastIndexOf(".");
  return dot === -1 ? qualified : qualified.slice(dot + 1);
}

// ── Definition extraction ────────────────────────────────────────────────────────────

const IDENT = '(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)';
const QNAME = `(?:${IDENT}\\s*\\.\\s*)?${IDENT}`;

/**
 * Objects a migration CREATES or ADDS. Keys are `kind:schema.name`, plus
 * `column:schema.table.column` for columns introduced by `alter table ... add column`.
 */
export function extractDefinitions(sql) {
  const code = stripComments(sql);
  const defs = new Set();
  const detail = [];

  const add = (kind, qname, extra) => {
    if (!qname) return;
    const key = `${kind}:${qname}`;
    if (!defs.has(key)) {
      defs.add(key);
      detail.push({ kind, name: qname, key, ...(extra ?? {}) });
    }
  };

  // create [or replace] [unique] [materialized] <kind> [if not exists] <name>
  const createRe = new RegExp(
    "\\bcreate\\s+(?:or\\s+replace\\s+)?(?:unique\\s+)?(?:materialized\\s+)?" +
      "(table|index|function|procedure|type|view|sequence|trigger|policy|schema|extension|domain|aggregate)\\s+" +
      `(?:if\\s+not\\s+exists\\s+)?(${QNAME})`,
    "gi",
  );
  for (const m of code.matchAll(createRe)) {
    const kind = m[1].toLowerCase();
    // Triggers and policies live in the namespace of their table, not a schema.
    if (kind === "trigger" || kind === "policy" || kind === "schema" || kind === "extension") {
      add(kind, m[2].trim().replace(/"/g, "").replace(/\s+/g, "").toLowerCase());
      continue;
    }
    add(kind, qualify(m[2]));
  }

  // Anonymous index: `create index on t (...)` — no name to key on, but it is a
  // dependency on `t`, which the reference pass picks up. Recorded for completeness.
  const anonIdxRe = new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?on\\s+(${QNAME})`, "gi");
  for (const m of code.matchAll(anonIdxRe)) {
    detail.push({ kind: "index", name: `(anonymous on ${qualify(m[1])})`, key: null, anonymous: true });
  }

  // alter table <t> ... add column [if not exists] <c>
  const alterRe = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})([\\s\\S]*?);`, "gi");
  for (const m of code.matchAll(alterRe)) {
    const table = qualify(m[1]);
    const body = m[2];
    const colRe = new RegExp(`\\badd\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})`, "gi");
    for (const c of body.matchAll(colRe)) {
      const col = c[1].replace(/"/g, "").toLowerCase();
      add("column", `${table}.${col}`, { table });
    }
    const consRe = new RegExp(`\\badd\\s+constraint\\s+(${IDENT})`, "gi");
    for (const c of body.matchAll(consRe)) {
      add("constraint", c[1].replace(/"/g, "").toLowerCase(), { table });
    }
  }

  return { keys: defs, detail };
}

/**
 * Object names a migration MENTIONS. Deliberately name-based: the resolver only keeps a
 * mention that matches an object some EARLIER migration defined, so unrelated words are
 * discarded at resolution time rather than here.
 */
export function extractMentions(sql) {
  const code = stripComments(sql).toLowerCase();
  const words = new Set();
  for (const m of code.matchAll(/[a-z_][a-z0-9_]*(?:\s*\.\s*[a-z_][a-z0-9_]*)?/g)) {
    words.add(m[0].replace(/\s+/g, ""));
  }
  return words;
}

// ── Set-level analysis ───────────────────────────────────────────────────────────────

export const VERSION_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** Version key exactly as `scripts/migrate.mjs` computes it: the first four characters. */
export function runnerVersion(filename) {
  return filename.slice(0, 4);
}

/**
 * Content hash. Line endings are normalised first so a CRLF checkout never reports a
 * different migration from the same committed bytes (the failure class behind PR-F-013).
 */
export function sha256(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Build the per-migration record set for one branch.
 * `files`: Array<{filename, content}>.
 */
export function buildInventory(files) {
  const rows = [];
  for (const f of files) {
    const m = VERSION_RE.exec(f.filename);
    const { keys, detail } = extractDefinitions(f.content);
    rows.push({
      version: runnerVersion(f.filename),
      number: m ? Number(m[1]) : Number.NaN,
      filename: f.filename,
      wellFormed: Boolean(m),
      sha256: sha256(f.content),
      bytes: Buffer.byteLength(f.content.replace(/\r\n/g, "\n"), "utf8"),
      defines: [...keys].sort(),
      definesDetail: detail,
      mentions: extractMentions(f.content),
    });
  }
  rows.sort((a, b) => a.filename.localeCompare(b.filename));
  return rows;
}

/**
 * Resolve dependency edges WITHIN one branch's inventory.
 *
 * An edge Y depends-on X exists when Y mentions an object that X defines and X is
 * numbered below Y. Only the LOWEST-numbered definer below Y is credited, so a
 * `create or replace` chain attributes the dependency to the migration that first
 * introduced the object.
 */
export function resolveDependencies(rows) {
  // key → lowest-numbered migration defining it
  const definer = new Map();
  for (const r of [...rows].sort((a, b) => a.number - b.number)) {
    for (const k of r.defines) if (!definer.has(k)) definer.set(k, r);
  }

  // Index by the bare name a later migration would actually write.
  const byName = new Map();
  for (const [key, r] of definer) {
    const kind = key.slice(0, key.indexOf(":"));
    const qname = key.slice(key.indexOf(":") + 1);
    for (const alias of new Set([qname, bare(qname)])) {
      if (!byName.has(alias)) byName.set(alias, []);
      byName.get(alias).push({ key, kind, qname, row: r });
    }
  }

  for (const r of rows) {
    const deps = new Map(); // version → Set(objectKey)
    for (const word of r.mentions) {
      const hits = byName.get(word);
      if (!hits) continue;
      for (const h of hits) {
        if (h.row.number >= r.number) continue; // self or later: not a dependency
        // A column mention is only credited when the owning table is mentioned too;
        // bare column words like `status` are far too common to trust alone.
        if (h.kind === "column") {
          const table = h.qname.slice(0, h.qname.lastIndexOf("."));
          if (!r.mentions.has(table) && !r.mentions.has(bare(table))) continue;
        }
        if (!deps.has(h.row.version)) deps.set(h.row.version, new Set());
        deps.get(h.row.version).add(h.key);
      }
    }
    r.dependsOn = [...deps.entries()]
      .map(([version, keys]) => ({ version, via: [...keys].sort() }))
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  // Reverse edges.
  const dependents = new Map();
  for (const r of rows) {
    for (const d of r.dependsOn ?? []) {
      if (!dependents.has(d.version)) dependents.set(d.version, new Set());
      dependents.get(d.version).add(r.version);
    }
  }
  for (const r of rows) r.dependedOnBy = [...(dependents.get(r.version) ?? [])].sort();

  return rows;
}

/** Transitive closure of "depends on `startVersion`" over the resolved rows. */
export function transitiveDependents(rows, startVersion) {
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const direct = new Set(byVersion.get(startVersion)?.dependedOnBy ?? []);
  const seen = new Set(direct);
  const queue = [...direct];
  while (queue.length) {
    const v = queue.shift();
    for (const next of byVersion.get(v)?.dependedOnBy ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return { direct: [...direct].sort(), all: [...seen].sort() };
}
