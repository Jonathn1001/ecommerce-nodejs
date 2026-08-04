import { openOrderStream } from "../stream";

type Listener = (e: { data?: string }) => void;

// A fake that behaves like the real thing in the one way that matters: it delivers the
// service's frames as a NAMED "status" event (services/order/src/app.ts writes
// `event: status`). A fake built around onmessage would make every test here pass against a
// page that receives nothing.
function fakeEventSource() {
  const listeners = new Map<string, Listener[]>();
  let closed = false;
  const es = {
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    close() {
      closed = true;
    },
  };
  return {
    create: () => es,
    emit: (type: string, data?: string) =>
      (listeners.get(type) ?? []).forEach((fn) => fn({ data })),
    isClosed: () => closed,
  };
}

const noop = { onFrame: () => {}, onError: () => {} };

it("delivers a named status frame", () => {
  const fake = fakeEventSource();
  const frames: unknown[] = [];
  openOrderStream(
    "o1",
    { ...noop, onFrame: (f) => frames.push(f) },
    { create: fake.create }
  );
  fake.emit("status", JSON.stringify({ orderId: "o1", status: "AWAITING_PAYMENT" }));
  expect(frames).toEqual([{ orderId: "o1", status: "AWAITING_PAYMENT" }]);
});

it("subscribes same-origin under /api", () => {
  const fake = fakeEventSource();
  let seen = "";
  openOrderStream("o 1", noop, {
    create: (url) => {
      seen = url;
      return fake.create();
    },
  });
  expect(seen).toBe("/api/orders/o%201/stream");
});

// The stream is a progress indicator; the query underneath it is the authority. A frame that
// does not match the contract is dropped, not thrown.
it("ignores a frame that is not a valid status", () => {
  const fake = fakeEventSource();
  const frames: unknown[] = [];
  openOrderStream(
    "o1",
    { ...noop, onFrame: (f) => frames.push(f) },
    { create: fake.create }
  );
  fake.emit("status", JSON.stringify({ orderId: "o1", status: "WAT" }));
  fake.emit("status", "not json at all");
  fake.emit("status", undefined);
  expect(frames).toEqual([]);
});

it("reports errors and closes on demand", () => {
  const fake = fakeEventSource();
  let errors = 0;
  const handle = openOrderStream(
    "o1",
    { ...noop, onError: () => (errors += 1) },
    { create: fake.create }
  );
  fake.emit("error");
  handle.close();
  expect(errors).toBe(1);
  expect(fake.isClosed()).toBe(true);
});
