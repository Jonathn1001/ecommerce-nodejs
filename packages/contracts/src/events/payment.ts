import { z } from "zod";

export const CHARGE_PAYMENT = "payment.charge" as const;
export const PAYMENT_SUCCEEDED = "payment.succeeded" as const;
export const PAYMENT_FAILED = "payment.failed" as const;

// RabbitMQ command. amount is integer minor units (Order is the pricing authority).
export const ChargePaymentPayloadSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1), // Payment scopes its read routes by this
  amount: z.number().int().positive(),
});
export type ChargePaymentPayload = z.infer<typeof ChargePaymentPayloadSchema>;

export const PaymentSucceededPayloadSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type PaymentSucceededPayload = z.infer<typeof PaymentSucceededPayloadSchema>;

export const PaymentFailedPayloadSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1),
});
export type PaymentFailedPayload = z.infer<typeof PaymentFailedPayloadSchema>;

export const PAYMENT_REFUNDED = "payment.refunded" as const;

export const PaymentRefundedPayloadSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type PaymentRefundedPayload = z.infer<typeof PaymentRefundedPayloadSchema>;
