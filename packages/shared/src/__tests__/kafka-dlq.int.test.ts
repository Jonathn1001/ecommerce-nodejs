import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { makeEnvelope, HELLO_CREATED, type EventEnvelope } from "@ecom/contracts";
import { createKafka, createProducer, createConsumer } from "../kafka";

describe("kafka consumer error boundary (integration — needs stack up)", () => {
  it("parks a poison message on <topic>.dlq after exhausting retries", async () => {
    const topic = `test.poison.${uuidv4()}`;
    const kafka = createKafka("test-dlq");

    // Provision topics up front (deployments provision topics; this broker does
    // not auto-create on consumer metadata, so subscribing to a not-yet-created
    // <topic>.dlq would otherwise throw before the first park ever happens).
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic }, { topic: `${topic}.dlq` }],
    });
    await admin.disconnect();

    const producer = createProducer(kafka);
    const failing = createConsumer(kafka, `g-${uuidv4()}`);
    const dlqReader = createConsumer(kafka, `gdlq-${uuidv4()}`);

    const parked: EventEnvelope[] = [];
    await dlqReader.connect();
    await dlqReader.run([`${topic}.dlq`], async (env) => void parked.push(env));

    await failing.connect();
    await failing.run(
      [topic],
      async () => {
        throw new Error("poison");
      },
      { maxRetries: 1 }
    );

    await producer.connect();
    await producer.publish(
      topic,
      makeEnvelope({
        type: HELLO_CREATED,
        version: 1,
        traceId: "t",
        producer: "test",
        payload: { helloId: "h", name: "x" },
      })
    );

    const deadline = Date.now() + 20_000;
    while (parked.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 300));
    await producer.disconnect();
    await failing.disconnect();
    await dlqReader.disconnect();

    expect(parked).toHaveLength(1);
  });
});
