import { describe, it, expect, afterAll } from "vitest";
import { context, trace, TraceFlags, type SpanContext } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { randomUUID } from "crypto";
import { prisma } from "../db";
import { placeOrderTx } from "../tx-adapters";

// @opentelemetry/api's default ContextManager is a no-op: context.with(ctx, fn) just
// calls fn() without making ctx active, so context.active() inside fn (which is what
// currentTraceparent() reads) would keep returning the empty ROOT_CONTEXT no matter
// what SpanContext this test injects. Production processes get a real ContextManager
// for free from tracing.ts's NodeSDK.start() (the NODE_OPTIONS preload); this test
// runs standalone, so it registers its own — same test-only pattern Task 3 used in
// packages/shared/src/__tests__/trace.test.ts. Registering twice in the same process
// is harmless (@opentelemetry/api logs and ignores a duplicate registration).
new NodeTracerProvider().register();

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("outbox rows capture the active traceparent (integration)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("writes the active span's context onto the row", async () => {
    const orderId = `o_${randomUUID()}`;
    const sc: SpanContext = {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    await context.with(trace.setSpanContext(context.active(), sc), async () => {
      await prisma.$transaction(async (tx) => {
        await placeOrderTx(tx, "t").enqueue("order.placed", orderId, {});
      });
    });
    const row = await prisma.outbox.findFirst({ where: { aggregateId: orderId } });
    expect(row?.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("writes null when there is no active span, rather than throwing", async () => {
    const orderId = `o_${randomUUID()}`;
    await prisma.$transaction(async (tx) => {
      await placeOrderTx(tx, "t").enqueue("order.placed", orderId, {});
    });
    const row = await prisma.outbox.findFirst({ where: { aggregateId: orderId } });
    expect(row?.traceparent).toBeNull();
  });
});
