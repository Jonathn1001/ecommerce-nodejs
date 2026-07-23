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

export async function handleChargePayment(env: EventEnvelope): Promise<void> {
  if (env.type !== CHARGE_PAYMENT) return; // not ours — no-op
  const { orderId, amount } = ChargePaymentPayloadSchema.parse(env.payload);
  const outcome = await prisma.$transaction((tx) =>
    chargeOrder(chargeTx(tx, env.traceId), { eventId: env.eventId, orderId, amount })
  );
  log.info("charge_handled", { orderId, outcome, traceId: env.traceId });
}
