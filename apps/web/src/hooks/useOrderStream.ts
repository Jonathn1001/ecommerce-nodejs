import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OrderDetail, OrderStatus } from "@ecom/contracts";
import { openOrderStream, type EventSourceFactory } from "../api/stream";
import { refreshSession } from "../api/refresh";
import type { FailedAt } from "../order/saga-steps";

// Chosen against the saga_duration p(99)<5000 threshold in k6/checkout.js:21 — fast enough
// that a fallback user sees the pipeline move, slow enough that a settled page is not a load
// source.
export const POLL_INTERVAL_MS = 3000;
export const MAX_STREAM_ERRORS = 3;

const isTerminal = (s: OrderStatus) => s === "CONFIRMED" || s === "CANCELLED";

/**
 * Liveness for one order, as a ladder that TERMINATES.
 *
 * EventSource reconnects forever on its own and exposes no status code, so an expired access
 * token, a 404 for someone else's order, and a dropped connection are the same event. Counting
 * errors rather than interpreting them is what lets this stop: rung 1 fixes the one cause the
 * client can fix, rung 3 gives up on the transport, and a terminal status ends everything.
 *
 * Never SSE and polling at once — parallel polling would keep the page correct while the
 * stream was completely broken, which is the failure this whole phase exists to make visible.
 */
export function useOrderStream(
  orderId: string,
  opts: { create?: EventSourceFactory } = {}
): { polling: boolean; failedAt: FailedAt } {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const [failedAt, setFailedAt] = useState<FailedAt>(null);
  const create = opts.create;

  // Refs, not state: the ladder must not re-render the page, and a stale closure over the
  // error count would let every error in a burst read zero.
  const lastStatus = useRef<OrderStatus | null>(null);
  const errors = useRef(0);
  const refreshing = useRef(false);
  const handle = useRef<{ close: () => void } | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    errors.current = 0;
    lastStatus.current = null;

    const stop = () => {
      stopped.current = true;
      handle.current?.close();
      handle.current = null;
    };

    const open = () => {
      if (stopped.current) return;
      handle.current = openOrderStream(
        orderId,
        {
          onFrame: (f) => {
            // Advance an existing order; never materialise one. The service sends the current
            // status on subscribe, so a frame routinely beats GET /orders/:id, and a
            // {status}-only object would render an order with no lines.
            qc.setQueryData<OrderDetail>(["order", orderId], (old) =>
              old ? { ...old, status: f.status } : old
            );
            // Only a transition observed live says which leg failed. A cold load whose first
            // frame is already CANCELLED leaves this null, and the tracker blames no step.
            if (
              f.status === "CANCELLED" &&
              lastStatus.current &&
              !isTerminal(lastStatus.current)
            )
              setFailedAt(lastStatus.current);
            lastStatus.current = f.status;
            if (isTerminal(f.status)) {
              setPolling(false);
              stop();
            }
          },
          onError: () => {
            if (stopped.current || refreshing.current) return;
            errors.current += 1;
            if (errors.current === 1) {
              // Close BEFORE refreshing. EventSource reconnects on its own ~3s timer, and that
              // attempt would 401 again mid-refresh and spend a second rung on a problem
              // already being fixed.
              refreshing.current = true;
              handle.current?.close();
              handle.current = null;
              void refreshSession().finally(() => {
                refreshing.current = false;
                open();
              });
              return;
            }
            if (errors.current >= MAX_STREAM_ERRORS) {
              stop();
              setPolling(true);
            }
          },
        },
        create ? { create } : {}
      );
    };

    open();
    return stop;
  }, [orderId, qc, create]);

  return { polling, failedAt };
}
