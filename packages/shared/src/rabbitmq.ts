import amqp, { type Channel, type ChannelModel } from "amqplib";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";

export async function createRabbit() {
  const conn: ChannelModel = await amqp.connect(
    process.env.RABBITMQ_URL ?? "amqp://ecom:ecom@localhost:5672"
  );
  const ch: Channel = await conn.createChannel();

  let healthy = true;
  conn.on("close", () => {
    healthy = false;
  });
  conn.on("error", () => {
    healthy = false;
  });

  async function assertWorkQueue(queue: string): Promise<void> {
    const dlx = `${queue}.dlx`;
    const dlq = `${queue}.dlq`;
    await ch.assertExchange(dlx, "fanout", { durable: true });
    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, dlx, "");
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: dlx });
  }

  async function sendCommand(queue: string, envelope: EventEnvelope): Promise<void> {
    ch.sendToQueue(queue, Buffer.from(JSON.stringify(envelope)), { persistent: true });
  }

  async function consumeCommands(
    queue: string,
    handler: (env: EventEnvelope) => Promise<void>,
    opts: { maxRetries?: number } = {}
  ): Promise<void> {
    const { maxRetries = 3 } = opts;
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      let env: EventEnvelope;
      try {
        env = EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      } catch {
        ch.nack(msg, false, false); // malformed envelope -> DLQ; retrying can't help
        return;
      }
      try {
        await withRetry(() => handler(env), {
          retries: maxRetries,
          baseMs: 200,
          label: `consume:${queue}`,
        });
        ch.ack(msg);
      } catch {
        ch.nack(msg, false, false); // handler exhausted retries -> DLX/DLQ
      }
    });
  }

  async function consumeDlqOnce(
    dlq: string,
    timeoutMs: number
  ): Promise<EventEnvelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await ch.get(dlq, { noAck: true });
      if (msg) return EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  async function checkHealth(): Promise<void> {
    if (!healthy) throw new Error("rabbit connection is down");
  }

  async function close(): Promise<void> {
    await ch.close();
    await conn.close();
  }

  return { assertWorkQueue, sendCommand, consumeCommands, consumeDlqOnce, checkHealth, close };
}
