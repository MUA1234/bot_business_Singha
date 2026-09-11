#!/usr/bin/env bash
# Runs the hard-scenario suites against the live local stack.
# Every value here is non-secret and local. Credentials are never echoed.
set -euo pipefail
KEYS="${HST_KEYS_FILE:?set HST_KEYS_FILE to the generated local-keys.json}"
export HST_GATEWAY_URL="${HST_GATEWAY_URL:-http://127.0.0.1:54321}"
export HST_APP_URL="${HST_APP_URL:-http://127.0.0.1:3241}"

# ── Read the keys, and FAIL if you cannot ──────────────────────────────────────────────────
#
# This used to be `node -e "console.log(require(process.argv[1]).anon)" "$KEYS"`, and it had two
# faults that combined into a silent green run.
#
#   1. `require()` treats a path with no leading `./` as a PACKAGE name. The documented invocation
#      passes a repo-relative path — `.hard-scenario/local-keys.json` — so require threw
#      MODULE_NOT_FOUND and printed nothing to stdout.
#   2. `export VAR=$(...)` has the exit status of `export`, which is 0. `set -e` never fired.
#
# So both keys became empty strings, `stackConfigured` in `tests/hard-scenario/helpers/stack.ts`
# went false, and EIGHT of the ten suites skipped themselves entirely — 93 of 120 tests. The runner
# still exited 0 and printed "27 passed". The helper's comment says the suite skips rather than
# passes "so a missing environment can never be mistaken for a green campaign"; that protection
# works per-suite and was defeated at the top level, where nothing was checking.
#
# `readFileSync` + `JSON.parse` takes the path as a path. Then each key is asserted non-empty,
# because a key that is missing from the file would reintroduce exactly the same silence.
read_key() {
  node -e '
    const { readFileSync } = require("node:fs");
    const v = JSON.parse(readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof v !== "string" || v.length === 0) {
      console.error(`hard-scenario: "${process.argv[2]}" is missing or empty in ${process.argv[1]}`);
      process.exit(1);
    }
    process.stdout.write(v);
  ' "$KEYS" "$1"
}

HST_ANON_KEY="$(read_key anon)"
HST_SERVICE_KEY="$(read_key service)"
export HST_ANON_KEY HST_SERVICE_KEY
export DEV_FIXTURE_PASSWORD="${DEV_FIXTURE_PASSWORD:?required}"

# The same condition the suites use, checked HERE, where a failure stops the run instead of
# quietly turning it into a skip. Lengths only — never the values.
if [ -z "$HST_ANON_KEY" ] || [ -z "$HST_SERVICE_KEY" ] || [ -z "$DEV_FIXTURE_PASSWORD" ]; then
  echo "hard-scenario: refusing to run — the stack is not configured, and a skipped campaign is not a passing one." >&2
  exit 1
fi
echo "hard-scenario: stack configured (anon ${#HST_ANON_KEY} chars, service ${#HST_SERVICE_KEY} chars, fixture password set)"

exec npx vitest run -c vitest.hard-scenario.config.ts "$@"
