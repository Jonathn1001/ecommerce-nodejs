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
    const ok = makeEnvelope({ type: "cmd.ok", version: 1, traceId: "t", producer: "test", payload: {} });
    await rabbit.sendCommand(q, ok);

    let deadline = Date.now() + 10_000;
    while (got.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(got).toHaveLength(1);

    // failure path: a throwing handler routes the message to <q>.dlq
    const badQ = `${q}.bad`;
    await rabbit.assertWorkQueue(badQ);
    await rabbit.consumeCommands(badQ, async () => {
      throw new Error("boom");
    });
    await rabbit.sendCommand(badQ, makeEnvelope({ type: "cmd.bad", version: 1, traceId: "t", producer: "test", payload: {} }));

    const dlq = await rabbit.consumeDlqOnce(`${badQ}.dlq`, 10_000);
    await rabbit.close();
    expect(dlq?.type).toBe("cmd.bad");
  });
});
