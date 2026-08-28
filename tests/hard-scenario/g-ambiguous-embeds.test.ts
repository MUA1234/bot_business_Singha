/**
 * REGRESSION GATE — no PostgREST embed may reference an ambiguous relationship.
 *
 * This exists because of findings F-002 and F-003, and because the class is systemic
 * rather than local. Composite tenant-integrity foreign keys mean many parent/child
 * pairs now carry TWO keys. PostgREST cannot choose a join path for such a pair and
 * refuses the whole request with `PGRST201`. The refusal arrives as an error with
 * `data: null`, so a call site that reads a null result as "there is nothing here"
 * renders an empty, confident, WRONG screen — and no test that mocks the database will
 * ever notice, because the mock returns a shape the database cannot produce.
 *
 * `src/lib/embeds.ts` fixed the sites that were known. This gate makes the rule
 * enforceable: it reads the ambiguous pairs from the LIVE schema rather than from a
 * hard-coded list, so a migration that makes a NEW pair ambiguous fails this test
 * instead of silently emptying a screen months later.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const DB_URL = process.env.DATABASE_URL ?? "";
const enabled = Boolean(DB_URL);

/**
 * Every parent/child pair in `public` joined by more than one foreign key.
 *
 * Read straight from the catalogue over a plain connection — the same approach the
 * integration suite uses — so this gate needs no migration of its own.
 */
async function ambiguousPairs(): Promise<Set<string>> {
  const { default: pg } = await import("pg" as string);
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
        where c.contype = 'f' and n.nspname = 'public'
        group by 1, 2
       having count(*) > 1`,
    );
    const set = new Set<string>();
    for (const r of rows as { child: string; parent: string }[]) {
      // regclass may render schema-qualified; keep the bare table name.
      const bare = (s: string) => s.replace(/^public\./, "").replace(/"/g, "");
      set.add(`${bare(r.child)}->${bare(r.parent)}`);
    }
    return set;
  } finally {
    await client.end();
  }
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (/\.(ts|tsx)$/.test(p)) acc.push(p);
  }
  return acc;
}

/**
 * Find `.from("parent")` … `.select("… child(cols) …")` pairs.
 *
 * Deliberately simple and deliberately over-inclusive: it scans each `from("x")`
 * occurrence and the select string that follows it in the same statement. A false
 * positive is a comment to write; a false negative is an empty screen in production.
 */
function embedsIn(source: string): { parent: string; child: string; line: number }[] {
  const found: { parent: string; child: string; line: number }[] = [];
  const re = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)([\s\S]{0,400}?)\.select\(\s*["'`]([^"'`]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const parent = m[1]!;
    const selectArg = m[3]!;
    const line = source.slice(0, m.index).split("\n").length;
    // Embed tokens look like `child(...)` or `child!hint(...)`, not aggregate calls.
    const embedRe = /([a-z_][a-z0-9_]*)\s*(?:![a-z_!]+)?\s*\(/g;
    let e: RegExpExecArray | null;
    while ((e = embedRe.exec(selectArg)) !== null) {
      const child = e[1]!;
      if (["count", "sum", "avg", "min", "max"].includes(child)) continue;
      found.push({ parent, child, line });
    }
  }
  return found;
}

describe.skipIf(!enabled)("regression — no ambiguous PostgREST embeds", () => {
  let ambiguous: Set<string>;

  beforeAll(async () => {
    ambiguous = await ambiguousPairs();
  });

  it("the live schema really does contain ambiguous pairs (the control)", () => {
    // If this is empty the gate below would pass vacuously.
    expect(ambiguous.size).toBeGreaterThan(0);
  });

  it("no source file embeds across an ambiguous relationship", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const source = readFileSync(file, "utf8");
      for (const { parent, child, line } of embedsIn(source)) {
        // The relationship can be declared in either direction.
        if (ambiguous.has(`${child}->${parent}`) || ambiguous.has(`${parent}->${child}`)) {
          offenders.push(`${file.replace(/\\/g, "/")}:${line} — ${parent}.select(… ${child}(…) …)`);
        }
      }
    }
    expect(
      offenders,
      `these embeds cannot be answered by PostgREST and will render an empty screen:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
