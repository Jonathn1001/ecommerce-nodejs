import { z } from "zod";

export const ORDER_PLACED = "order.placed" as const;
export const ORDER_CANCELLED = "order.cancelled" as const;

export const OrderLineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderPlacedPayloadSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export type OrderPlacedPayload = z.infer<typeof OrderPlacedPayloadSchema>;

export const OrderCancelledPayloadSchema = z.object({
  orderId: z.string().min(1),
});
export type OrderCancelledPayload = z.infer<typeof OrderCancelledPayloadSchema>;
