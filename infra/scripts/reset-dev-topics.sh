#!/usr/bin/env bash
# Truncates the durable dev topics. Every new consumer group subscribes fromBeginning, so a
# long-lived broker makes each e2e run replay more history until the 25s poll budgets break.
# Deletes records only — topics and their configs survive.
#
# Local dev only: every service's own `.events` outbox topic (all 7 non-gateway services;
# gateway has no Kafka producer/consumer at all). CI is exempt — every CI run starts a fresh
# broker (see ci.yml's `integration` job), so there is no history to accumulate there.
set -euo pipefail
CONTAINER="${KAFKA_CONTAINER:-ecom-platform-kafka-1}"
TOPICS="${TOPICS:-hello.events inventory.events order.events payment.events catalog.events notification.events identity.events}"

for topic in $TOPICS; do
  offset=$(docker exec "$CONTAINER" /opt/kafka/bin/kafka-get-offsets.sh \
    --bootstrap-server localhost:9092 --topic "$topic" 2>/dev/null | cut -d: -f3 || echo "")
  [ -z "$offset" ] && { echo "skip $topic (absent)"; continue; }
  docker exec "$CONTAINER" sh -c "cat > /tmp/trunc.json <<JSON
{\"partitions\":[{\"topic\":\"$topic\",\"partition\":0,\"offset\":$offset}],\"version\":1}
JSON
/opt/kafka/bin/kafka-delete-records.sh --bootstrap-server localhost:9092 --offset-json-file /tmp/trunc.json" >/dev/null
  echo "truncated $topic to $offset"
done
