# Merge-candidate strategy and artifact policy

Addresses item 8 of the remediation brief. Nothing here has been executed — the pushed
branches are left exactly as they are, as instructed.

## The problem

`claude/uiux-v3-v4-checkpoint` (SHA `d65c502`) contains **188 screenshot PNGs, ~140 MB**,
committed as evidence for the V3/V4 visual work. Git keeps every byte of that in history
permanently, on every clone, for every contributor, forever. It is consistent with the
existing precedent (`screenshots/uiux-v1` is 59 MB already tracked) but the precedent is
the thing that should stop, not a reason to continue.

The eventual merge candidate should contain **code, tests and concise reports**.

## What has already changed

From this round onward, no screenshot binary is added to git:

- `artifacts/` is gitignored. The viewport/accessibility audit writes
  `artifacts/hard-scenario/spatial-viewport-audit.json` plus a `.sha256` beside it.
- `.playwright-mcp/` is gitignored (browser session snapshots and console logs).
- The report records each artifact's **SHA-256 and the commit it was produced at**, so a
  reviewer can regenerate it and compare, which is what the evidence is actually for.

Regenerating is one command and needs no network:

```bash
HST_KEYS_FILE=<local-keys.json> DEV_FIXTURE_PASSWORD=<local> \
  node scripts/hard-scenario/spatial-viewport-audit.mjs
```

## Recommended approach — a fresh, code-only merge candidate

**Do not rewrite or force-push the existing branches.** They are the audit trail for this
work and the owner has both SHAs. Build a new branch beside them instead.

```bash
# 1. Start from main, so no screenshot blob is ever an ancestor.
git checkout -b claude/uiux-v3-v4-merge-candidate main

# 2. Bring across the tree WITHOUT the screenshot directories.
git checkout claude/hard-scenario-testing -- . 
git rm -r --cached screenshots/uiux-v3 screenshots/uiux-v3-auth screenshots/layout-audit
rm -rf screenshots/uiux-v3 screenshots/uiux-v3-auth screenshots/layout-audit

# 3. Ignore the pattern going forward.
printf '\nscreenshots/uiux-v3*/\nscreenshots/layout-audit/\n' >> .gitignore

# 4. Verify the candidate is small and complete.
git count-objects -vH          # expect a few MB, not ~140 MB
npm run typecheck && npm run lint && npm test
```

This yields **one squashed, reviewable commit** containing the V3/V4 interface, the three
R1 fixes, migration 0109, the campaign harness and suites, and the reports — with no
large binary in its history.

### Where the screenshots go instead

| Option | When it fits |
|---|---|
| Regenerate on demand from the committed harness | Default. The scripts are in the repo; the images are derived data. |
| CI artifact retention (e.g. 30–90 days) | If a reviewer needs to see them without running anything. |
| A release attachment or object store, referenced by URL + checksum | If a specific visual baseline must be preserved long-term. |

### If the ~140 MB must be removed from history entirely

That requires rewriting `claude/uiux-v3-v4-checkpoint`, which changes its SHA and breaks
every reference to it — including this report's. It is an **owner decision** and should
be done, if at all, with `git filter-repo` on a clone, after the branches have served
their review purpose. It is deliberately NOT proposed as part of this round.

## What must NOT be in the merge candidate

- Screenshot binaries (above).
- `artifacts/`, `.playwright-mcp/`, `.env.verify`, `.env.local`.
- The campaign's local keys file — it lives only in the scratchpad and is not in the repo.

## What SHOULD be in it

- The V3/V4 interface and the R1 defect fixes (F-002, F-003, F-006).
- `src/db/migrations/0109_bounded_user_text.sql` and the `dec()` hardening (F-004, F-005).
- `scripts/hard-scenario/*` — gateway, net guard, tenant-B seed, self-check, audit,
  rollback rehearsal — because they make every result in the report reproducible.
- `tests/hard-scenario/*`, `tests/money-boundary.test.ts`,
  `tests/spatial/layout-persistence.test.tsx`,
  `tests/spatial/coverage-scale-and-states.test.ts`.
- `docs/hard-scenario/*` — three concise documents, no binaries.
