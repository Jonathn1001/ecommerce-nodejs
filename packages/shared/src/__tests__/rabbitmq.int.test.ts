import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";
import { createRabbit } from "../rabbitmq";

describe("rabbitmq wrapper (integration — needs docker compose up)", () => {
  it("delivers a command; a throwing handler dead-letters it", async () => {
    const q = `test.cmd.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);

    // happy path: handler receives the command
    const got: EventEnvelope[] = [];
    await rabbit.consumeCommands(q, async (env) => {
      got.push(env);
    });
    const ok = makeEnvelope({
      type: "cmd.ok",
      version: 1,
      traceId: "t",
      producer: "test",
      payload: {},
    });
    await rabbit.sendCommand(q, ok);

    const deadline = Date.now() + 10_000;
    while (got.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    expect(got).toHaveLength(1);

    // failure path: a throwing handler routes the message to <q>.dlq
    const badQ = `${q}.bad`;
    await rabbit.assertWorkQueue(badQ);
    await rabbit.consumeCommands(badQ, async () => {
      throw new Error("boom");
    });
    await rabbit.sendCommand(
      badQ,
      makeEnvelope({
        type: "cmd.bad",
        version: 1,
        traceId: "t",
        producer: "test",
        payload: {},
      })
    );

    const dlq = await rabbit.consumeDlqOnce(`${badQ}.dlq`, 10_000);
    await rabbit.close();
    expect(dlq?.type).toBe("cmd.bad");
  });

  it("retries a transiently-throwing handler and acks on eventual success (no DLQ)", async () => {
    const q = `test.retry.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);

    let attempts = 0;
    const done: string[] = [];
    await rabbit.consumeCommands(
      q,
      async (env) => {
        attempts++;
        if (attempts < 3) throw new Error("transient"); // fail twice, succeed on the 3rd
        done.push(env.eventId);
      },
      { maxRetries: 3 }
    );
    await rabbit.sendCommand(
      q,
      makeEnvelope({ type: "cmd.retry", version: 1, traceId: "t", producer: "test", payload: {} })
    );

    const deadline = Date.now() + 10_000;
    while (done.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));

    const dlq = await rabbit.consumeDlqOnce(`${q}.dlq`, 1_000); // must be empty
    await rabbit.close();
    expect(done).toHaveLength(1); // handler eventually succeeded
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(dlq).toBeNull(); // never dead-lettered
  });
});
