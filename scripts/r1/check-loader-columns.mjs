/**
 * Verify EVERY column the production loaders select actually exists.
 *
 * R2C-F-002 was a loader selecting two columns that do not exist, which had silently disabled a
 * whole domain. One instance of that class means checking the rest rather than assuming.
 */
import { readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import pg from "pg";

const NAME = "singha-colcheck-pg16";
const PORT = process.env.COLCHECK_PORT ?? "55501";
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const clean = () => { try { execSync(`docker rm -f ${NAME}`, { stdio: "ignore" }); } catch { /* gone */ } };

clean();
execFileSync("docker", [
  "run", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=postgres",
  "-p", `127.0.0.1:${PORT}:5432`, "postgres:16",
], { stdio: "inherit" });

for (let i = 0; i < 90; i++) {
  try { execSync(`docker exec ${NAME} pg_isready -U postgres`, { stdio: "ignore" });
       execSync("ping -n 3 127.0.0.1 > NUL", { stdio: "ignore" }); break; }
  catch { execSync("ping -n 2 127.0.0.1 > NUL", { stdio: "ignore" }); }
}

let code = 0;
try {
  const boot = new pg.Client({ connectionString: URL, ssl: false });
  await boot.connect();
  await boot.query(readFileSync("tests/integration/helpers/supabase-shim.sql", "utf8"));
  await boot.end();
  execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: URL }, stdio: "pipe" });
  execFileSync("node", ["scripts/r1/draft-migrate.mjs", "--up"], {
    env: { ...process.env, DATABASE_URL: URL, R1_DRAFT_CONFIRM: "disposable-local-only" }, stdio: "pipe",
  });

  const db = new pg.Client({ connectionString: URL, ssl: false });
  await db.connect();

  const src = readFileSync("src/kernel/cycle-deps.ts", "utf8");
  const re = /from\("(\w+)"\)[\s\S]{0,200}?\.select\("([^"]+)"\)/g;
  const pairs = new Map();
  let m;
  while ((m = re.exec(src))) {
    const cols = m[2].split(",").map((c) => c.trim()).filter(Boolean);
    pairs.set(m[1] + "|" + m[2], { table: m[1], cols });
  }

  const problems = [];
  for (const { table, cols } of pairs.values()) {
    const { rows } = await db.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1`, [table]);
    if (rows.length === 0) { problems.push(`${table}: TABLE NOT FOUND`); continue; }
    const have = new Set(rows.map((r) => r.column_name));
    for (const c of cols) if (!have.has(c)) problems.push(`${table}.${c} DOES NOT EXIST`);
  }
  await db.end();

  if (problems.length) {
    console.error("COLUMN PROBLEMS:\n  " + problems.join("\n  "));
    code = 1;
  } else {
    console.log(`OK: every column selected by the loaders exists (${pairs.size} distinct selects checked)`);
  }
} catch (e) {
  console.error("check failed:", e.message);
  code = 1;
} finally {
  clean();
}
process.exit(code);
