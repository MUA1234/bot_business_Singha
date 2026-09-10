/**
 * Reading migration sets out of git, for the base-aware tooling.
 *
 * Kept separate from the analysis core so that core stays pure and testable: everything
 * that touches git or the filesystem lives here, and the analysis takes plain
 * `Array<{filename, content}>`.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export const MIGRATIONS_DIR = "src/db/migrations";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** True when `ref` resolves in this clone (CI shallow clones may not have origin/main). */
export function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function resolveSha(ref) {
  return git(["rev-parse", ref]).trim();
}

/** Migration files as committed at `ref`. */
export function readMigrationsAtRef(ref) {
  const listing = git(["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_DIR]);
  const files = listing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"))
    .sort();

  return files.map((path) => ({
    filename: path.slice(path.lastIndexOf("/") + 1),
    content: git(["show", `${ref}:${path}`]),
  }));
}

/** Migration files in the working tree. */
export function readMigrationsFromWorkingTree(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, content: readFileSync(`${dir}/${filename}`, "utf8") }));
}
