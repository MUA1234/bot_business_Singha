# Which SHA produced which result

The previous report presented a block of totals under the heading *"Totals at `c8d3c99`"*. That
heading was **not accurate for every line beneath it**. This document records what actually ran
where, so the record is checkable rather than asserted.

## The SHAs

```
git rev-parse HEAD                                          850cf760b4c79dd3715cf283cff5bb7802c3c8b0
git rev-parse origin/claude/product-recovery-deploy-candidate 850cf760b4c79dd3715cf283cff5bb7802c3c8b0
git status --short                                          (empty — clean)
```

Every commit after `e41692d`:

| SHA | Subject | Changed files |
|---|---|---|
| `1878ffe4090de3a49d2f41f17cde2d524903d50f` | Make the hard-scenario stack reproducible, and fix a false positive in C4 | `.gitignore`, `scripts/hard-scenario/up.mjs` (new), `tests/hard-scenario/c-crm-sales.test.ts` |
| `c8d3c996ce14772bbeb8f519a0cbf997df1290c4` | The cycle lock could never be released on the deployed transport | `R1_DRAFT_030_cycle_lease.{up,down}.sql` (new), `src/kernel/cycle-deps.ts`, `tests/hard-scenario/j-deployed-loop.test.ts` (new), `tests/integration/r1-atomic-create.test.ts`, `tests/integration/r1-runtime-e2e.test.ts` |
| `850cf760b4c79dd3715cf283cff5bb7802c3c8b0` | Staging could not be built, and the draft chain regresses two baselines | `docs/architecture-v3.1/COMPLETION_INVENTORY.md`, `docs/release-1/STAGING-AND-PRODUCTION-PLAN.md` (new) |

`e41692d` differs from `e7b6c52` in documentation only — verified by comparing tree hashes of
`src`, `scripts`, `tests`, `public`, `package.json`, `package-lock.json`, `next.config.mjs` and
`tsconfig.json`, all identical.

`850cf76` differs from `c8d3c99` in documentation only (the table above shows both files).

## Attribution

| Result | Ran at | Same as `c8d3c99` code? |
|---|---|---|
| unit 2554 / 4 skipped | `c8d3c99` working tree, pre-commit | yes |
| no-network 28 files / 774 | `c8d3c99` (committed) | yes |
| core integration 77 / 696 | `c8d3c99` (committed) | yes |
| kernel 37 files / 746 | `c8d3c99` working tree, pre-commit | yes |
| draft-schema 31 | `c8d3c99` (committed) | yes |
| migration attacks 12/12 | `c8d3c99` (committed) | yes |
| ledger rehearsal | `c8d3c99` (committed) | yes |
| execution attacks, digest identical over 177 tables | `c8d3c99` (committed) | yes |
| typecheck · build · lint · secret-scan · migration-lint · collision · inventory · IP-boundary · requirements · audit-check | `c8d3c99` (committed) | yes |
| hard-scenario 10 files / 120 tests → **118 passed, 2 failed** | `c8d3c99` (committed), app rebuilt at it | yes |
| deployed-loop 13/13 | included in the 120 above, at `c8d3c99` | yes |
| **browser viewport audit (390/768/1440/2560)** | **an intermediate tree between `1878ffe` and `c8d3c99`** — after draft 030 and the per-PROCESS lease owner, before the per-cycle token | **NO** |

### The one inaccurate line, stated plainly

The browser audit did **not** run at `c8d3c99`. It ran while the kernel campaign was still
executing, against a tree carrying the first (wrong) lease fix. Its subject — viewport layout,
keyboard reachability, accessibility names — is not touched by the lease change, so the result is
very unlikely to differ. That is a reason to expect it to reproduce, not a reason to have listed
it under a SHA it did not run at. It is re-run in the campaign that follows this document.

### Two other results the previous report should not have blurred

* **hard-scenario 9 files / 107 tests** was measured at `1878ffe`, before draft 030 existed. It is
  superseded by the 10-file / 120-test run at `c8d3c99`, which is the number that counts.
* **`j-deployed-loop` 13/13 first passed** on the per-PROCESS lease tree. That tree was wrong — two
  kernel suites caught it — so that first pass proves nothing. The 13/13 that counts is the one
  inside the `c8d3c99` run.

### And the failure the heading obscured

"118/120" was reported, but a reader skimming the totals line could take the block as green. It
was not: **`F5` (tenant-integrity FK gap 103 → 120) and `F-004` (41 unbounded writable text
columns) both failed at `c8d3c99`**, and both are the subject of the work that follows.
