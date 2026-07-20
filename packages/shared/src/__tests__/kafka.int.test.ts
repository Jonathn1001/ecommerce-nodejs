import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { makeEnvelope, HELLO_CREATED, type EventEnvelope } from "@ecom/contracts";
import { createKafka, createProducer, createConsumer } from "../kafka";

describe("kafka wrapper (integration — needs docker compose up)", () => {
  it("round-trips a validated envelope", async () => {
    const topic = `test.hello.${uuidv4()}`;
    const kafka = createKafka("test-kafka");
    const producer = createProducer(kafka);
    const consumer = createConsumer(kafka, `g-${uuidv4()}`);

    // Pre-create the topic via the admin API before subscribing. KafkaJS's
    // relies-on-auto-create path (consumer.subscribe() against a topic that
    // doesn't exist yet) has a documented broker-side race on freshly created
    // topics — the metadata response can advertise a leader for the new
    // partition before the broker's own replica manager has caught up, so the
    // very next request fails with a retriable UNKNOWN_TOPIC_OR_PARTITION
    // ("This server does not host this topic-partition"), and KafkaJS's
    // `Cluster.addMultipleTargetTopics` does NOT retry that error itself (see
    // kafkajs/src/cluster/index.js) — it reverts and rethrows. Handling that
    // retry is explicitly out of scope for this task (Task 16:
    // retry-connect/consumer-error-boundary), so the test sidesteps the race
    // by ensuring the topic exists (and has a settled leader) before the
    // wrapper's subscribe/run ever runs — this is also closer to production,
    // where topics are provisioned ahead of time rather than relied upon to
    // auto-create on first consume.
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    const received: EventEnvelope[] = [];
    await consumer.connect();
    await consumer.run([topic], async (env) => {
      received.push(env);
    });
    await producer.connect();

    const sent = makeEnvelope({
      type: HELLO_CREATED,
      version: 1,
      traceId: "t1",
      producer: "test",
      payload: { helloId: "h1", name: "ada" },
    });
    await producer.publish(topic, sent);

    const deadline = Date.now() + 15_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    await producer.disconnect();
    await consumer.disconnect();

    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe(sent.eventId);
    expect(received[0].payload).toEqual(sent.payload);
  });
});
