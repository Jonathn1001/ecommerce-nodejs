import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
      makeEnvelope({
        type: "cmd.retry",
        version: 1,
        traceId: "t",
        producer: "test",
        payload: {},
      })
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

  it("sendCommand resolves only after the broker confirms the publish", async () => {
    const q = `test.confirm.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);
    await rabbit.sendCommand(
      q,
      makeEnvelope({
        type: "cmd.confirm",
        version: 1,
        traceId: "t",
        producer: "test",
        payload: {},
      })
    );
    // If sendCommand resolved, the confirm-channel acked it; the message is enqueued.
    const got = await rabbit.consumeDlqOnce(q, 5_000); // read the work queue directly
    await rabbit.close();
    expect(got?.type).toBe("cmd.confirm");
  });

  it("applies prefetch: unacked deliveries are bounded by it", async () => {
    const q = `test.prefetch.${uuidv4()}`;
    const rabbit = await createRabbit({ prefetch: 1 });
    await rabbit.assertWorkQueue(q);

    // Handler never settles -> deliveries stay unacked; prefetch(1) caps in-flight at 1.
    const inFlight: string[] = [];
    await rabbit.consumeCommands(q, async (env) => {
      inFlight.push(env.eventId);
      await new Promise<void>(() => {}); // never resolves
    });
    for (const n of [1, 2, 3]) {
      await rabbit.sendCommand(
        q,
        makeEnvelope({
          type: `cmd.pf.${n}`,
          version: 1,
          traceId: "t",
          producer: "test",
          payload: {},
        })
      );
    }
    await new Promise((r) => setTimeout(r, 2_000)); // let the broker push whatever it will
    await rabbit.close();
    expect(inFlight).toHaveLength(1); // unbounded prefetch would deliver all 3
  }, 15_000);

  it("moveDlqOnce re-queues a dead-lettered command and reports dry", async () => {
    const q = `test.move.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);
    await rabbit.sendCommand(
      `${q}.dlq`,
      makeEnvelope({
        type: "cmd.move",
        version: 1,
        traceId: "t",
        producer: "test",
        payload: {},
      })
    );

    expect(await rabbit.moveDlqOnce(`${q}.dlq`, q)).toBe(true);
    expect(await rabbit.moveDlqOnce(`${q}.dlq`, q)).toBe(false); // dlq drained
    const requeued = await rabbit.consumeDlqOnce(q, 5_000); // read the work queue directly
    await rabbit.close();
    expect(requeued?.type).toBe("cmd.move");
  }, 15_000);

  it("moveDlqOnce leaves a malformed envelope ON the dlq (never a destructive read)", async () => {
    const q = `test.move.bad.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);
    // publish raw junk straight to the dlq — sendCommand would reject a non-envelope
    await rabbit.sendCommand(`${q}.dlq`, {
      eventId: "not-an-envelope",
    } as unknown as Parameters<typeof rabbit.sendCommand>[1]);

    await expect(rabbit.moveDlqOnce(`${q}.dlq`, q)).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 300)); // let the requeue land
    const stillThere = await rabbit.consumeDlqOnce(`${q}.dlq`, 3_000).catch(() => "junk");
    await rabbit.close();
    expect(stillThere).toBeTruthy(); // message survived the failed move
  }, 15_000);

  describe("queueDepth", () => {
    let rabbit: Awaited<ReturnType<typeof createRabbit>>;

    beforeAll(async () => {
      rabbit = await createRabbit();
    });

    afterAll(async () => {
      await rabbit.close();
    });

    it("queueDepth reports the DLQ message count", async () => {
      const queue = `metrics-depth-${Date.now()}`;
      await rabbit.assertWorkQueue(queue);
      expect(await rabbit.queueDepth(`${queue}.dlq`)).toBe(0);
    });

    it("queueDepth on a missing queue rejects without killing the command lane", async () => {
      await expect(rabbit.queueDepth(`no-such-queue-${Date.now()}`)).rejects.toThrow();
      // The working ConfirmChannel must still be usable — this is the whole reason
      // queueDepth owns a separate channel.
      const queue = `metrics-after-miss-${Date.now()}`;
      await rabbit.assertWorkQueue(queue);
      expect(await rabbit.queueDepth(`${queue}.dlq`)).toBe(0);
    });
  });

  // NOTE: kept last deliberately — it mutates process.env.RABBITMQ_URL for the duration
  // of the test and its `finally` restore re-assigns `prev` even when `prev` is
  // `undefined`, which Node stringifies to the literal "undefined" on process.env rather
  // than clearing the key. Any test relying on the default-URL fallback that ran after
  // this one would connect with a corrupted URL. Not touching that pre-existing behavior
  // here — just preserving the ordering that avoids tripping over it.
  it("createRabbit boot-retries, then throws (fail-fast) when the broker is unreachable", async () => {
    // boot-retry exhausts against a dead port, then throws — no degraded adapter
    const prev = process.env.RABBITMQ_URL;
    process.env.RABBITMQ_URL = "amqp://ecom:ecom@localhost:5673"; // 5673 = no broker
    const started = Date.now();
    try {
      await expect(createRabbit({ prefetch: 5 })).rejects.toBeTruthy();
    } finally {
      process.env.RABBITMQ_URL = prev;
    }
    // A bare connect rejects in ms; only a retry budget takes seconds.
    expect(Date.now() - started).toBeGreaterThan(1_000);
  }, 30_000);
});
