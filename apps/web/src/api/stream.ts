import { OrderStatusSchema, type OrderStatus } from "@ecom/contracts";
import { z } from "zod";

export type StatusFrame = { orderId: string; status: OrderStatus };

const FrameSchema = z.object({ orderId: z.string(), status: OrderStatusSchema });

// Structural, not the DOM's EventSource: the constructor is undefined in the test environment
// (jsdom does not implement it, and Node 22 has no global either), so the factory has to be
// injectable or none of the ladder above this module could be tested at all.
export type EventSourceLike = {
  addEventListener(type: string, fn: (e: { data?: string }) => void): void;
  close(): void;
};
export type EventSourceFactory = (url: string) => EventSourceLike;

const defaultCreate: EventSourceFactory = (url) =>
  new EventSource(url) as unknown as EventSourceLike;

export function openOrderStream(
  orderId: string,
  handlers: { onFrame: (f: StatusFrame) => void; onError: () => void },
  opts: { create?: EventSourceFactory } = {}
): { close: () => void } {
  const create = opts.create ?? defaultCreate;
  // Same-origin under /api, so the session cookie rides automatically — EventSource cannot set
  // headers, which is why the gateway authenticates this stream from the cookie.
  const es = create(`/api/orders/${encodeURIComponent(orderId)}/stream`);

  // NAMED event. The service writes `event: status`, and EventSource routes a named event ONLY
  // to a matching addEventListener — `onmessage` would never fire.
  es.addEventListener("status", (e) => {
    let raw: unknown;
    try {
      raw = JSON.parse(e.data ?? "");
    } catch {
      return;
    }
    const parsed = FrameSchema.safeParse(raw);
    if (parsed.success) handlers.onFrame(parsed.data);
  });

  es.addEventListener("error", () => handlers.onError());

  return { close: () => es.close() };
}
