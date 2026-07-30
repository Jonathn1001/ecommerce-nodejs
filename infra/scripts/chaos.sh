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
STOPPED=""

# Restores whatever the scenario broke, however it exits. Without this, ANY failure between
# `stop` and `start` — a failed assertion under `set -e`, or a Ctrl-C — leaves the service
# down and the background driver orphaned and still writing. That is not hypothetical: it
# happened during 7d's own C4 run and the resulting stalled saga read convincingly as a lost
# event. A scenario must leave the stack the way it found it even when it fails.
cleanup() {
  local code=$?
  trap - EXIT INT TERM # a signal runs this AND then the EXIT trap; restore once, not twice
  [ -n "$DRIVER" ] && kill "$DRIVER" 2>/dev/null || true
  if [ -n "$STOPPED" ]; then
    echo "cleanup: restarting $STOPPED" >&2
    $COMPOSE start "$STOPPED" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

drive() {
  COUNT="${1:-20}" INTERVAL_MS="${2:-500}" PRODUCT_ID="$PRODUCT_ID" \
    npx tsx infra/scripts/drive-checkouts.ts &
  DRIVER=$!
}
# `|| true` is load-bearing: with no driver started, the bare test returns 1, and under
# `set -e` a non-zero function return aborts the whole script.
settle() {
  [ -n "$DRIVER" ] && { wait "$DRIVER" 2>/dev/null || true; }
  DRIVER=""
  return 0
}

# Paired with cleanup() above: record what is down so it gets restored on any exit path.
break_service() {
  STOPPED="$1"
  $COMPOSE stop "$1"
}
restore_service() {
  $COMPOSE start "$STOPPED"
  STOPPED=""
}

assert() {
  PGBASE="$PGBASE" npx tsx infra/scripts/assert-invariants.ts "$1"
}

PROM_URL="${PROM_URL:-http://localhost:9090}"
ALERT_WAIT_SECONDS="${ALERT_WAIT_SECONDS:-180}"

# Reports whether the named alert is firing right now. Exit status only.
alert_is_firing() {
  curl -s "$PROM_URL/api/v1/alerts" | ALERT="$1" python3 -c '
import sys, json, os
alerts = json.load(sys.stdin)["data"]["alerts"]
firing = {a["labels"]["alertname"] for a in alerts if a["state"] == "firing"}
sys.exit(0 if os.environ["ALERT"] in firing else 1)
'
}

# PRECONDITION for the whole validation: the alert must be quiet before we break anything.
# Burn-rate windows are 15m and 1h, so an alert left firing by an earlier run stays firing
# well into this one — and then wait_for_alert succeeds on its first poll having proven
# nothing at all. Observing the inactive -> firing TRANSITION is the only thing that ties the
# alert to this outage. Same discipline as the poison scenario refusing a dirty DLQ.
require_alert_quiet() {
  if alert_is_firing "$1"; then
    echo "FAIL: $1 is ALREADY firing before the outage — its window still holds a previous" >&2
    echo "      run's errors, so this scenario cannot prove anything. Wait for it to resolve" >&2
    echo "      (up to the 1h long window) and re-run." >&2
    return 1
  fi
  echo "$1 quiet before the outage"
}

# Waits for the alert WHILE the outage is still running, rather than sampling once.
#
# Polling, not a single read, because the firing time is not knowable in advance: the
# fast-burn's long leg is a 15m rate whose denominator still contains every healthy request
# from the preceding quarter hour, so how long the ratio takes to cross 14.4% depends on how
# much healthy traffic came before — and then `for: 30s` adds its own delay on top. A single
# read at outage_start + 120s missed a real firing by 33 seconds, and under `set -e` that
# aborted the scenario before the service was restarted, leaving the stack down and a saga
# stalled. That looked exactly like a lost event until the consumer group showed lag 1 with
# no member attached.
#
# Still bounded to the outage window, never after recovery: the short leg is a 1m rate that
# decays within about a minute of traffic going healthy, and an alert that has already
# resolved by the time you look is indistinguishable from one that never fired.
wait_for_alert() {
  local want="$1" deadline=$((SECONDS + ALERT_WAIT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if alert_is_firing "$want"; then
      echo "$want fired during the outage"
      curl -s "$PROM_URL/api/v1/alerts" | python3 -c '
import sys, json
alerts = json.load(sys.stdin)["data"]["alerts"]
for state in ("firing", "pending"):
    print(f"  {state}:", sorted({a["labels"]["alertname"] for a in alerts if a["state"] == state}))
'
      return 0
    fi
    sleep 5
  done
  echo "FAIL: $want did not fire within ${ALERT_WAIT_SECONDS}s of the outage" >&2
  curl -s "$PROM_URL/api/v1/alerts" | python3 -c '
import sys, json
alerts = json.load(sys.stdin)["data"]["alerts"]
print("  states seen:", sorted((a["labels"]["alertname"], a["state"]) for a in alerts), file=sys.stderr)
' >&2
  return 1
}

case "$SCENARIO" in
kafka) # The roadmap's Done-when case: kill the broker mid-saga, lose nothing.
  drive 20 500
  sleep 3
  break_service kafka
  sleep "$OUTAGE_SECONDS"
  restore_service
  settle
  assert clean
  ;;

inventory) # A mid-saga service outage: orders pile at PENDING, then drain.
  # NOTE: RESERVATION_TTL_MS defaults to 900_000 (15 min), so a 15s outage exercises the
  # DELAY regime, not compensation. Reaching compensation needs inventory restarted with a
  # small TTL — see the runbook.
  drive 20 500
  sleep 3
  break_service inventory
  sleep "$OUTAGE_SECONDS"
  restore_service
  settle
  assert clean
  ;;

poison) # Parks without stalling the partition — the Phase 3b parse fix.
  # The assertion below is on ABSOLUTE DLQ depth, so this scenario needs a clean start.
  # Checking rather than pre-draining is deliberate: messages already parked before this
  # run are a real finding, and silently erasing them would hide it. Drain deliberately
  # with `npx tsx infra/scripts/drain-dlq.ts` once you have looked at them.
  assert clean
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
  # Drain what we parked, then prove the stack is clean again. Without this the scenarios
  # are silently order-dependent: the parked messages fail every later scenario's "clean"
  # assertion, so running poison before kafka makes kafka look broken. Set KEEP_POISON=1 to
  # leave the messages in place for inspection.
  if [ -z "${KEEP_POISON:-}" ]; then
    npx tsx infra/scripts/drain-dlq.ts
    assert clean
  fi
  ;;

order) # The ONLY scenario that produces gateway-visible errors, and therefore the only one
  # that can validate the burn-rate alerts. The gateway proxies order, catalog and payment
  # and has no /inventory mount at all, so C1's Kafka stop, C2's inventory stop and C3's
  # poison message move no gateway error counter. Stopping order makes the gateway answer
  # 503 (open circuit), 504 (timeout) or 502 (unreachable) from proxy.ts, all of which
  # match status=~"5..". Both /cart and /orders are order-service routes, so every
  # iteration produces two failures rather than one.
  #
  # Two properties are load-bearing, and each fails in a way that looks like a broken rule:
  #  - The outage must OUTLAST the long window. Fast-burn needs the 1m and 15m legs
  #    breaching together, and a 15-second blip cannot move a 15m rate.
  #  - Traffic must KEEP FLOWING throughout. An error rate needs a denominator; a driver
  #    that stops when requests start failing flattens the rate instead of climbing it.
  # 600 orders at 500ms is about 300s of traffic, which must span the outage AND the
  # wait_for_alert poll after it — the alert can need well over two minutes of sustained
  # errors before it fires, and the driver going quiet first is what flattens the rate.
  ORDER_OUTAGE_SECONDS="${ORDER_OUTAGE_SECONDS:-90}"
  EXPECT_ALERT="${EXPECT_ALERT:-CheckoutErrorBudgetFastBurn}"
  require_alert_quiet "$EXPECT_ALERT"
  drive 600 500
  sleep 5
  break_service order
  sleep "$ORDER_OUTAGE_SECONDS"
  wait_for_alert "$EXPECT_ALERT"
  # Restart before the driver is done, so recovery is observed under live traffic and the
  # final assertion covers orders placed on both sides of the outage.
  restore_service
  settle
  assert clean
  ;;

*)
  echo "unknown scenario: $SCENARIO" >&2
  exit 64
  ;;
esac
