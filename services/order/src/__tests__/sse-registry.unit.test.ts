import { describe, it, expect } from "vitest";
import { SubscriberRegistry, type Sink, type StatusFrame } from "../sse-listener";

function fakeSink() {
  const sent: StatusFrame[] = [];
  let ended = false;
  const sink: Sink = {
    send: (f) => sent.push(f),
    end: () => {
      ended = true;
    },
  };
  return { sink, sent, ended: () => ended };
}

describe("SubscriberRegistry", () => {
  it("dispatches a frame only to that order's subscribers", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink(),
      b = fakeSink();
    r.subscribe("o1", a.sink);
    r.subscribe("o2", b.sink);
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.sent).toEqual([{ orderId: "o1", status: "AWAITING_PAYMENT" }]);
    expect(b.sent).toEqual([]);
  });
  it("fans out to multiple subscribers of one order", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink(),
      b = fakeSink();
    r.subscribe("o1", a.sink);
    r.subscribe("o1", b.sink);
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });
  it("ends + removes subscribers on a terminal status", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink();
    r.subscribe("o1", a.sink);
    r.dispatch({ orderId: "o1", status: "CONFIRMED" });
    expect(a.ended()).toBe(true);
    expect(r.size("o1")).toBe(0);
  });
  it("does not end on a non-terminal status", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink();
    r.subscribe("o1", a.sink);
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.ended()).toBe(false);
    expect(r.size("o1")).toBe(1);
  });
  it("unsubscribe() stops further frames", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink();
    const off = r.subscribe("o1", a.sink);
    off();
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.sent).toEqual([]);
    expect(r.size("o1")).toBe(0);
  });
});
