import express from "express";
import { traceMiddleware, createLogger } from "@ecom/shared";
import { HELLO_CREATED, HelloCreatedPayloadSchema } from "@ecom/contracts";
import { prisma } from "./db";

const log = createLogger("hello");

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.post("/hello", async (req, res) => {
    const name = String(req.body?.name ?? "");
    if (!name) return res.status(400).json({ error: "name required" });

    try {
      const created = await prisma.$transaction(async (tx) => {
        const rec = await tx.helloRecord.create({ data: { name } });
        const payload = HelloCreatedPayloadSchema.parse({
          helloId: rec.id,
          name: rec.name,
        });
        await tx.outbox.create({
          data: {
            id: rec.id,
            aggregateType: "hello",
            aggregateId: rec.id,
            type: HELLO_CREATED,
            version: 1,
            traceId: req.traceId,
            producer: "hello",
            payload,
          },
        });
        return rec;
      });

      log.info("hello_created", { helloId: created.id, traceId: req.traceId });
      res.status(201).json({ helloId: created.id });
    } catch {
      // Express 4 does not forward a rejected async-handler promise to error
      // middleware, so any throw here (Zod parse failure, DB error, deadlock)
      // must be caught explicitly — otherwise it becomes an unhandled
      // rejection that hangs the client and can crash the process, taking
      // the relay + consumer down with it. Never log the caught error's
      // message/stack or the request body — ids/codes only.
      log.error("hello_failed", { traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
