import type { OrderStatus } from "@ecom/contracts";
import { stepsFor, type FailedAt, type Step, type StepState } from "../order/saga-steps";

// Colour encodes saga state per the design language — so every step ALSO carries a glyph and a
// spelled-out condition, and the pipeline stays readable in greyscale and to a screen reader.
const GLYPH: Record<StepState, string> = {
  done: "✓",
  active: "●",
  failed: "✕",
  pending: "○",
};
const CONDITION: Record<StepState, string> = {
  done: "done",
  active: "in progress",
  failed: "failed",
  pending: "waiting",
};
const TONE: Record<StepState, string> = {
  done: "text-[color:var(--color-ok)]",
  active: "text-[color:var(--color-live)]",
  failed: "text-[color:var(--color-fail)]",
  pending: "text-[color:var(--color-muted)]",
};

function announce(status: OrderStatus, steps: Step[]): string {
  if (status === "CONFIRMED") return "Order confirmed";
  if (status === "CANCELLED") {
    const failed = steps.find((s) => s.state === "failed");
    return failed ? `Order cancelled — ${failed.label} failed` : "Order cancelled";
  }
  const active = steps.find((s) => s.state === "active");
  return active ? `${active.label} in progress` : "Order placed";
}

export function OrderTracker({
  status,
  failedAt,
}: {
  status: OrderStatus;
  failedAt: FailedAt;
}) {
  const steps = stepsFor(status, failedAt);
  return (
    <div className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-4">
      <ol className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        {steps.map((s) => (
          <li
            key={s.key}
            aria-current={s.state === "active" ? "step" : undefined}
            className="flex items-center gap-2 sm:flex-1"
          >
            <span
              aria-hidden="true"
              className={`${TONE[s.state]} ${s.state === "active" ? "tracker-pulse" : ""}`}
            >
              {GLYPH[s.state]}
            </span>
            <span className="datum text-sm">{s.label}</span>
            <span className="sr-only">{CONDITION[s.state]}</span>
          </li>
        ))}
      </ol>
      {/* One announcement per transition, polite: three states can land in a few seconds. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce(status, steps)}
      </p>
    </div>
  );
}
