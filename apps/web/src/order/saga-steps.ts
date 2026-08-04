import type { OrderStatus } from "@ecom/contracts";

export type StepKey = "placed" | "reserved" | "payment" | "confirmed";
export type StepState = "done" | "active" | "failed" | "pending";
export type Step = { key: StepKey; label: string; state: StepState };

// The status the tracker last saw before a terminal CANCELLED arrived. Null when the page was
// loaded cold on an already-cancelled order — the one case where the failing leg is unknowable.
export type FailedAt = "PENDING" | "AWAITING_PAYMENT" | null;

const LABELS: Record<StepKey, string> = {
  placed: "Order placed",
  reserved: "Inventory reserved",
  payment: "Payment",
  confirmed: "Confirmed",
};

const ORDER: StepKey[] = ["placed", "reserved", "payment", "confirmed"];

// The choreographed saga has more transitions than Order has statuses, and THIS IS THE ONLY
// MODULE ALLOWED TO KNOW how the two relate. An order cannot reach AWAITING_PAYMENT unless the
// reservation succeeded (services/order/src/transition.ts:14), so the status is already the
// evidence a "reserved" step needs — no saga sub-events, no migration.
function statesFor(status: OrderStatus, failedAt: FailedAt): Record<StepKey, StepState> {
  switch (status) {
    case "PENDING":
      return {
        placed: "done",
        reserved: "active",
        payment: "pending",
        confirmed: "pending",
      };
    case "AWAITING_PAYMENT":
      return {
        placed: "done",
        reserved: "done",
        payment: "active",
        confirmed: "pending",
      };
    case "CONFIRMED":
      return { placed: "done", reserved: "done", payment: "done", confirmed: "done" };
    case "CANCELLED":
      // Two different failures produce one status. Only a transition observed live says which.
      if (failedAt === "PENDING")
        return {
          placed: "done",
          reserved: "failed",
          payment: "pending",
          confirmed: "pending",
        };
      if (failedAt === "AWAITING_PAYMENT")
        return {
          placed: "done",
          reserved: "done",
          payment: "failed",
          confirmed: "pending",
        };
      return {
        placed: "done",
        reserved: "pending",
        payment: "pending",
        confirmed: "pending",
      };
  }
}

export function stepsFor(status: OrderStatus, failedAt: FailedAt = null): Step[] {
  const states = statesFor(status, failedAt);
  return ORDER.map((key) => ({ key, label: LABELS[key], state: states[key] }));
}
