/**
 * The mutation-campaign lock.
 *
 * A mutation harness rewrites real source files in place and restores them when it finishes. A
 * commit taken during a run therefore captures a DELIBERATELY BROKEN boundary — the exact defect
 * the harness exists to detect — and it happened three times before this file existed.
 *
 * `.gitignore` already stops the harness's `.bak` files being staged. That was only half the
 * problem: the mutated SOURCE is a tracked file and staged happily. So a run now takes a lock, and
 * the pre-commit hook refuses while it is held.
 */
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";

export const MUTATION_LOCK = ".r1-mutation-campaign.lock";

export function takeMutationLock(name) {
  if (existsSync(MUTATION_LOCK)) {
    const held = readFileSync(MUTATION_LOCK, "utf8").trim();
    const pid = Number(held.split(":").pop());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) {
      throw new Error(`another mutation campaign is running (${held}); two would fight over the same files`);
    }
    console.log(`▶ clearing a stale mutation lock from a run that did not finish (${held})`);
  }
  writeFileSync(MUTATION_LOCK, `${name}:${process.pid}`, "utf8");

  const release = () => { try { unlinkSync(MUTATION_LOCK); } catch { /* advisory */ } };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(sig, () => { release(); process.exit(130); });
  }
  process.on("exit", release);
  process.on("uncaughtException", (e) => { console.error(e); release(); process.exit(1); });
  return release;
}
