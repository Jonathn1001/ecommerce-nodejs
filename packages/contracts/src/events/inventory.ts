import { z } from "zod";
import { OrderLineSchema } from "./order";

export const INVENTORY_RESERVED = "inventory.reserved" as const;
export const INVENTORY_RESERVATION_FAILED = "inventory.reservation_failed" as const;
export const INVENTORY_RELEASED = "inventory.released" as const;

export const InventoryReservedPayloadSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export type InventoryReservedPayload = z.infer<typeof InventoryReservedPayloadSchema>;

export const InventoryReservationFailedPayloadSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1),
});
export type InventoryReservationFailedPayload = z.infer<typeof InventoryReservationFailedPayloadSchema>;

export const InventoryReleasedPayloadSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export type InventoryReleasedPayload = z.infer<typeof InventoryReleasedPayloadSchema>;
