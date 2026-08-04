import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { makeQueryClient } from "../../api/queryClient";
import * as refreshApi from "../../api/refresh";
import { useOrderStream } from "../useOrderStream";

type Listener = (e: { data?: string }) => void;

// Records every EventSource the hook opens, so the ladder's "close and reopen" rung is
// observable rather than inferred.
function harness() {
  const instances: Array<{ listeners: Map<string, Listener[]>; closed: boolean }> = [];
  const create = () => {
    const inst = { listeners: new Map<string, Listener[]>(), closed: false };
    instances.push(inst);
    return {
      addEventListener(type: string, fn: Listener) {
        inst.listeners.set(type, [...(inst.listeners.get(type) ?? []), fn]);
      },
      close() {
        inst.closed = true;
      },
    };
  };
  const emit = (i: number, type: string, data?: string) =>
    (instances[i].listeners.get(type) ?? []).forEach((fn) => fn({ data }));
  return { create, emit, instances };
}

const wrapperFor = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

const cachedOrder = (status: string) => ({
  id: "o1",
  userId: "u1",
  status,
  totalPrice: 100,
  items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
  createdAt: "2026-08-04T00:00:00.000Z",
});

afterEach(() => vi.restoreAllMocks());

it("advances an order already in the cache", async () => {
  const client = makeQueryClient();
  const h = harness();
  client.setQueryData(["order", "o1"], cachedOrder("PENDING"));
  renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(client),
  });
  act(() =>
    h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "AWAITING_PAYMENT" }))
  );
  await waitFor(() =>
    expect((client.getQueryData(["order", "o1"]) as { status: string }).status).toBe(
      "AWAITING_PAYMENT"
    )
  );
  // The lines survive: the stream advances an order, it never rebuilds one.
  expect(
    (client.getQueryData(["order", "o1"]) as { items: unknown[] }).items
  ).toHaveLength(1);
});

// The service sends the current status on subscribe, so a frame routinely beats the GET. A
// {status}-only object would render an order with no lines — 8b's fabricated $0.00, again.
it("drops a frame that arrives before the order is cached", () => {
  const client = makeQueryClient();
  const h = harness();
  renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(client),
  });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CONFIRMED" })));
  expect(client.getQueryData(["order", "o1"])).toBeUndefined();
});

it("closes, refreshes once, and reopens on the first error", async () => {
  const h = harness();
  const refresh = vi.spyOn(refreshApi, "refreshSession").mockResolvedValue(true);
  renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(makeQueryClient()),
  });
  act(() => h.emit(0, "error"));
  await waitFor(() => expect(h.instances).toHaveLength(2));
  expect(h.instances[0].closed).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("falls back to polling on the third error and not before", async () => {
  const h = harness();
  vi.spyOn(refreshApi, "refreshSession").mockResolvedValue(true);
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(makeQueryClient()),
  });
  act(() => h.emit(0, "error"));
  await waitFor(() => expect(h.instances).toHaveLength(2));
  act(() => h.emit(1, "error"));
  expect(result.current.polling).toBe(false);
  act(() => h.emit(1, "error"));
  await waitFor(() => expect(result.current.polling).toBe(true));
  expect(h.instances[1].closed).toBe(true);
  // One transport at a time: nothing reopens after the ladder gives up.
  expect(h.instances).toHaveLength(2);
});

it("remembers the status it was in when a cancellation arrived", async () => {
  const client = makeQueryClient();
  const h = harness();
  client.setQueryData(["order", "o1"], cachedOrder("PENDING"));
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(client),
  });
  act(() =>
    h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "AWAITING_PAYMENT" }))
  );
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CANCELLED" })));
  await waitFor(() => expect(result.current.failedAt).toBe("AWAITING_PAYMENT"));
});

it("blames nothing when the first frame it ever sees is CANCELLED", async () => {
  const client = makeQueryClient();
  const h = harness();
  client.setQueryData(["order", "o1"], cachedOrder("CANCELLED"));
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(client),
  });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CANCELLED" })));
  await waitFor(() => expect(h.instances[0].closed).toBe(true));
  expect(result.current.failedAt).toBeNull();
});

it("stops everything on a terminal frame", async () => {
  const h = harness();
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(makeQueryClient()),
  });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CONFIRMED" })));
  await waitFor(() => expect(h.instances[0].closed).toBe(true));
  expect(result.current.polling).toBe(false);
  // A settled order must not resurrect the stream on a late error.
  act(() => h.emit(0, "error"));
  expect(h.instances).toHaveLength(1);
});

it("closes the stream on unmount", () => {
  const h = harness();
  const { unmount } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapperFor(makeQueryClient()),
  });
  unmount();
  expect(h.instances[0].closed).toBe(true);
});
