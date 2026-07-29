import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  CHARGE_PAYMENT,
  ChargePaymentPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { chargeOrder } from "./charge";
import { chargeTx } from "./tx-adapters";
import type { PaymentMetrics } from "./metrics";

const log: Logger = createLogger("payment-consumer");

const NOOP_PAYMENT: PaymentMetrics = { observe: () => {} };
let payment: PaymentMetrics = NOOP_PAYMENT;

// main.ts injects the real one; the no-op default keeps every existing test untouched.
export function setPaymentMetrics(m: PaymentMetrics): void {
  payment = m;
}

// ChargePaymentPayloadSchema (the exported contract) requires userId — every command Order
// enqueues from now on carries it. But a command already sitting in the queue, or replayed
// from the DLQ, when this deploy lands was minted under the narrower pre-userId contract and
// has no userId key at all. Hard-failing on that here would retry it 3x (consumeCommands)
// and then dead-letter it for good, leaving its order stuck in AWAITING_PAYMENT forever —
// worse than a payment we can't yet attribute to an owner. So consumption is deliberately
// more lenient than production: parse with userId optional and store null for a legacy
// command. The nullable Payment.userId column and the scoped GET route (a null-userId row
// 404s for every caller, same as a stranger's row) both already account for this.
const ChargePaymentConsumeSchema = ChargePaymentPayloadSchema.partial({ userId: true });

export async function handleChargePayment(env: EventEnvelope): Promise<void> {
  if (env.type !== CHARGE_PAYMENT) return; // not ours — no-op
  const { orderId, userId, amount } = ChargePaymentConsumeSchema.parse(env.payload);
  // Distinct from charge_handled: today only pre-deploy replays hit this (the sole producer
  // always supplies userId), so it should be rare. A sustained rate after the cutover window
  // means a producer regression is minting unowned, permanently-unreadable payments — this is
  // the signal that would catch it.
  if (!userId) log.warn("charge_missing_user_id", { orderId, traceId: env.traceId });
  const outcome = await prisma.$transaction((tx) =>
    chargeOrder(chargeTx(tx, env.traceId), {
      eventId: env.eventId,
      orderId,
      userId: userId ?? null,
      amount,
    })
  );
  // Recorded after the transaction resolves, so a rollback counts nothing. Spelled out
  // per outcome rather than lowercasing: DUPLICATE and ALREADY_CHARGED are idempotency
  // short-circuits, not charge attempts, and must fall through silently.
  if (outcome === "SUCCEEDED") payment.observe("succeeded");
  else if (outcome === "FAILED") payment.observe("failed");
  else if (outcome === "PROCESSING") payment.observe("processing");
  log.info("charge_handled", { orderId, outcome, traceId: env.traceId });
}
