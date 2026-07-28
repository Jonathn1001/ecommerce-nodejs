export type StatusFrame = { orderId: string; status: string };
export interface Sink {
  send(frame: StatusFrame): void;
  end(): void;
}

const TERMINAL = new Set(["CONFIRMED", "CANCELLED"]);

// Pure fan-out: orderId -> set of sinks. No I/O, unit-testable.
export class SubscriberRegistry {
  private map = new Map<string, Set<Sink>>();

  subscribe(orderId: string, sink: Sink): () => void {
    let set = this.map.get(orderId);
    if (!set) {
      set = new Set();
      this.map.set(orderId, set);
    }
    set.add(sink);
    return () => this.unsubscribe(orderId, sink);
  }

  unsubscribe(orderId: string, sink: Sink): void {
    const set = this.map.get(orderId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.map.delete(orderId);
  }

  dispatch(frame: StatusFrame): void {
    const set = this.map.get(frame.orderId);
    if (!set) return;
    const terminal = TERMINAL.has(frame.status);
    for (const sink of [...set]) {
      sink.send(frame);
      if (terminal) {
        sink.end();
        this.unsubscribe(frame.orderId, sink);
      }
    }
  }

  size(orderId: string): number {
    return this.map.get(orderId)?.size ?? 0;
  }
}
