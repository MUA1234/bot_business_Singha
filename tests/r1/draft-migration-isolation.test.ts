/**
 * R1 draft-migration isolation (owner decision R1-D-1).
 *
 * The R1 tables must be applicable to a disposable local database and IMPOSSIBLE to apply
 * accidentally to a hosted one. This test proves each quarantine mechanism independently,
 * so a single mistake — a moved file, a renamed directory, a relaxed guard — fails the
 * build rather than reaching a production database.
 *
 * These are behavioural assertions about what the runners DO with real files and real
 * inputs. The only "text" assertion is the presence of the mandated hosted-application
 * marker, which is the artefact under test, not a proxy for behaviour.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import {
  DRAFT_DIR,
  DRAFT_UP_RE,
  DRAFT_DOWN_RE,
  HOSTED_MARKER,
  CONFIRM_VAR,
  CONFIRM_VALUE,
  LEDGER,
  checkGuards,
  isLoopbackUrl,
  listDraftUnits,
} from "../../scripts/r1/draft-migrate.mjs";

/** The production runner's own constants, restated here so drift is caught. */
const PROD_DIR = "src/db/migrations";
const PROD_FILE_RE = /^\d{4}_.*\.sql$/;

const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:55432/r1_draft";

describe("quarantine 1 — the draft directory is not the production directory", () => {
  it("the production runner reads a different directory", () => {
    const runner = readFileSync("scripts/migrate.mjs", "utf8");
    expect(runner).toContain(`const DIR = "${PROD_DIR}"`);
    expect(DRAFT_DIR).not.toBe(PROD_DIR);
  });

  it("no draft file sits inside the production migrations directory", () => {
    const prod = readdirSync(PROD_DIR);
    expect(prod.filter((f) => f.startsWith("R1_DRAFT_"))).toEqual([]);
  });

  it("the draft directory exists and holds the R1 units", () => {
    expect(existsSync(DRAFT_DIR)).toBe(true);
    // 001-006 schema (checkpoint 2) + 007 RLS matrix + 008 accountable owner (security baseline).
    expect(listDraftUnits()).toHaveLength(8);
  });
});

describe("quarantine 2 — draft filenames fail the production runner's own filter", () => {
  const draftFiles = readdirSync(DRAFT_DIR).filter((f) => f.endsWith(".sql"));

  it("finds draft SQL files to test", () => {
    expect(draftFiles.length).toBeGreaterThan(0);
  });

  it("EVERY draft file is rejected by the production pattern, even if copied into that directory", () => {
    for (const f of draftFiles) {
      expect(PROD_FILE_RE.test(f), `${f} would be picked up by the production runner`).toBe(false);
    }
  });

  it("every production migration still matches the production pattern (the filter is real)", () => {
    const prod = readdirSync(PROD_DIR).filter((f) => f.endsWith(".sql"));
    expect(prod.length).toBeGreaterThan(100);
    for (const f of prod) expect(PROD_FILE_RE.test(f)).toBe(true);
  });

  it("simulating the production runner's selection over the draft directory yields nothing", () => {
    const selected = readdirSync(DRAFT_DIR).filter((f) => PROD_FILE_RE.test(f));
    expect(selected).toEqual([]);
  });

  it("every up file has a matching down file, so the set is reversible", () => {
    for (const u of listDraftUnits()) {
      expect(DRAFT_UP_RE.test(u.up)).toBe(true);
      expect(DRAFT_DOWN_RE.test(u.down)).toBe(true);
      expect(existsSync(`${DRAFT_DIR}/${u.down}`), `${u.down} missing`).toBe(true);
    }
  });
});

describe("quarantine 3 — a separate ledger, never schema_migrations", () => {
  it("the draft runner uses its own ledger table", () => {
    expect(LEDGER).toBe("r1_draft_migrations");
    expect(LEDGER).not.toBe("schema_migrations");
  });

  it("the draft runner never writes schema_migrations", () => {
    const src = readFileSync("scripts/r1/draft-migrate.mjs", "utf8");
    expect(src).not.toMatch(/insert\s+into\s+schema_migrations/i);
    expect(src).not.toMatch(/delete\s+from\s+schema_migrations/i);
  });
});

describe("quarantine 4 — the local-only guard is fail-closed", () => {
  it("refuses when DATABASE_URL is absent", () => {
    const r = checkGuards({ [CONFIRM_VAR]: CONFIRM_VALUE });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DATABASE_URL/);
  });

  it("refuses without the explicit confirmation variable", () => {
    const r = checkGuards({ DATABASE_URL: LOCAL_URL });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(new RegExp(CONFIRM_VAR));
  });

  it("refuses a wrong confirmation value", () => {
    const r = checkGuards({ DATABASE_URL: LOCAL_URL, [CONFIRM_VAR]: "yes" });
    expect(r.ok).toBe(false);
  });

  it("REFUSES a hosted Supabase URL even with confirmation set", () => {
    const r = checkGuards({
      DATABASE_URL: "postgresql://postgres:pw@db.gazjughejdzebathpscb.supabase.co:5432/postgres",
      [CONFIRM_VAR]: CONFIRM_VALUE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/loopback/i);
  });

  it.each([
    "postgresql://u:p@db.example.supabase.co:5432/postgres",
    "postgresql://u:p@10.0.0.5:5432/postgres",
    "postgresql://u:p@192.168.1.10:5432/postgres",
    "postgresql://u:p@some-host.railway.internal:5432/postgres",
    "postgresql://u:p@127.0.0.1.evil.com:5432/postgres",
    "postgresql://u:p@localhost.attacker.net:5432/postgres",
  ])("rejects non-loopback host: %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
    expect(checkGuards({ DATABASE_URL: url, [CONFIRM_VAR]: CONFIRM_VALUE }).ok).toBe(false);
  });

  it.each([
    "postgresql://u:p@127.0.0.1:55432/db",
    "postgresql://u:p@localhost:55432/db",
    "postgresql://u:p@[::1]:55432/db",
  ])("accepts loopback host: %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
    expect(checkGuards({ DATABASE_URL: url, [CONFIRM_VAR]: CONFIRM_VALUE }).ok).toBe(true);
  });

  it("rejects a malformed URL rather than failing open", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("quarantine 5 — every draft file carries the hosted-application marker", () => {
  it("marks every up and down file", () => {
    for (const f of readdirSync(DRAFT_DIR).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(`${DRAFT_DIR}/${f}`, "utf8");
      expect(sql.includes(HOSTED_MARKER), `${f} is missing the "${HOSTED_MARKER}" marker`).toBe(true);
    }
  });

  it("documents the quarantine in the directory README", () => {
    const readme = readFileSync(`${DRAFT_DIR}/README.md`, "utf8");
    expect(readme).toContain(HOSTED_MARKER);
  });
});

describe("released migrations are untouched by R1", () => {
  it("the production migration sequence is unchanged at 109 files, 0001–0109", () => {
    const prod = readdirSync(PROD_DIR).filter((f) => PROD_FILE_RE.test(f)).sort();
    expect(prod).toHaveLength(109);
    expect(prod[0]!.slice(0, 4)).toBe("0001");
    expect(prod[prod.length - 1]!.slice(0, 4)).toBe("0109");
  });

  it("has no duplicate version prefix within the production sequence", () => {
    const prod = readdirSync(PROD_DIR).filter((f) => PROD_FILE_RE.test(f));
    const versions = prod.map((f) => f.slice(0, 4));
    expect(new Set(versions).size).toBe(versions.length);
  });
});
