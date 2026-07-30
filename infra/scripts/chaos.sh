#!/usr/bin/env bash
# Chaos scenarios. Each: drive traffic -> break something -> restore -> wait for
# drain -> assert the invariants. A scenario "passes" only if the checker agrees.
set -euo pipefail

SCENARIO="${1:?usage: chaos.sh kafka|inventory|poison|order}"

# The compose invocation MUST carry the project name. Without -p, compose derives the
# project from the directory (ecommerce-nodejs) while the stack these scenarios target
# runs as ecom-platform, so `stop kafka` would cheerfully match nothing and the scenario
# would "pass" having broken precisely nothing. Override COMPOSE wholesale when the stack
# needs extra -f overrides (a port remap, for instance).
COMPOSE="${COMPOSE:-docker compose -p ecom-platform -f docker-compose.example.yml}"
PGBASE="${PGBASE:-postgresql://ecom:ecom@localhost:5432}"
OUTAGE_SECONDS="${OUTAGE_SECONDS:-15}"

: "${PRODUCT_ID:?PRODUCT_ID required — seed inventory stock first, see k6/README.md}"

DRIVER=""
drive() {
  COUNT="${1:-20}" INTERVAL_MS="${2:-500}" PRODUCT_ID="$PRODUCT_ID" \
    npx tsx infra/scripts/drive-checkouts.ts &
  DRIVER=$!
}
settle() { [ -n "$DRIVER" ] && { wait "$DRIVER" 2>/dev/null || true; }; }

assert() {
  PGBASE="$PGBASE" npx tsx infra/scripts/assert-invariants.ts "$1"
}

case "$SCENARIO" in
kafka) # The roadmap's Done-when case: kill the broker mid-saga, lose nothing.
  drive 20 500
  sleep 3
  $COMPOSE stop kafka
  sleep "$OUTAGE_SECONDS"
  $COMPOSE start kafka
  settle
  assert clean
  ;;

inventory) # A mid-saga service outage: orders pile at PENDING, then drain.
  # NOTE: RESERVATION_TTL_MS defaults to 900_000 (15 min), so a 15s outage exercises the
  # DELAY regime, not compensation. Reaching compensation needs inventory restarted with a
  # small TTL — see the runbook.
  drive 20 500
  sleep 3
  $COMPOSE stop inventory
  sleep "$OUTAGE_SECONDS"
  $COMPOSE start inventory
  settle
  assert clean
  ;;

poison) # Parks without stalling the partition — the Phase 3b parse fix.
  npx tsx infra/scripts/publish-poison.ts
  # The valid order placed AFTER the poison message must still reach a terminal state.
  # That is what distinguishes "parked" from "stalled partition"; a suite that only counted
  # DLQ entries would pass against a wedged consumer.
  drive 1 0
  settle
  # Expects EXACTLY the DLQ violation and nothing else. order.events has TWO consumer
  # groups — inventory-consumers and notification-dispatcher (services/inventory/src/main.ts:43,
  # services/notification/src/main.ts:44) — and each parks its own copy, so one published
  # poison message becomes two DLQ entries. Asserted as a number rather than "non-empty":
  # `assert_clean || true` would make this scenario pass no matter what happened.
  EXPECT_PARKED="${EXPECT_PARKED:-2}" assert poison
  ;;

order) # Task 7: the only scenario that produces gateway-visible errors.
  echo "the 'order' scenario is added in Task 7" >&2
  exit 64
  ;;

*)
  echo "unknown scenario: $SCENARIO" >&2
  exit 64
  ;;
esac
