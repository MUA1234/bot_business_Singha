#!/usr/bin/env bash
# Runs the hard-scenario suites against the live local stack.
# Every value here is non-secret and local. Credentials are never echoed.
set -euo pipefail
KEYS="${HST_KEYS_FILE:?set HST_KEYS_FILE to the generated local-keys.json}"
export HST_GATEWAY_URL="${HST_GATEWAY_URL:-http://127.0.0.1:54321}"
export HST_APP_URL="${HST_APP_URL:-http://127.0.0.1:3241}"
export HST_ANON_KEY="$(node -e "console.log(require(process.argv[1]).anon)" "$KEYS")"
export HST_SERVICE_KEY="$(node -e "console.log(require(process.argv[1]).service)" "$KEYS")"
export DEV_FIXTURE_PASSWORD="${DEV_FIXTURE_PASSWORD:?required}"
exec npx vitest run -c vitest.hard-scenario.config.ts "$@"
