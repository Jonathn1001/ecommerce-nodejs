import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  CHARGE_PAYMENT,
  ChargePaymentPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { chargeOrder } from "./charge";
import { chargeTx } from "./tx-adapters";

const log: Logger = createLogger("payment-consumer");

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
  const outcome = await prisma.$transaction((tx) =>
    chargeOrder(chargeTx(tx, env.traceId), {
      eventId: env.eventId,
      orderId,
      userId: userId ?? null,
      amount,
    })
  );
  log.info("charge_handled", { orderId, outcome, traceId: env.traceId });
}
