import { z } from "zod";

// The cart and order READ API the storefront consumes. Distinct from the event payloads in
// ../events/order, which describe what the saga publishes, not what a browser fetches.
// Strict: an additive server field must fail loudly. Order asserts its own cart responses
// against these same schemas, so drift breaks a backend test beside the change that caused it
// rather than surfacing months later in a client that quietly ignored the new field.
export const CartItemSchema = z
  .object({
    productId: z.string(),
    quantity: z.number().int(),
  })
  .strict();
export type CartItem = z.infer<typeof CartItemSchema>;

// No names and no prices — the cart carries ids and quantities only, so any UI must join
// against the catalogue to render a line.
export const CartSchema = z
  .object({
    userId: z.string(),
    items: z.array(CartItemSchema),
  })
  .strict();
export type Cart = z.infer<typeof CartSchema>;

// Integer MINOR UNITS, and the price CAPTURED at placement — not today's catalogue price.
export const OrderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number().int(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

// An unrecognised status must fail loudly rather than render as a blank badge.
export const OrderStatusSchema = z.enum([
  "PENDING",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "CANCELLED",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

// TWO schemas, because Order returns two shapes: POST answers `orderId` with no `userId` or
// `createdAt`; GET answers `id` with both. Collapsing them would force an optional
// identifier, and an absent id would then parse clean.
export const PlacedOrderSchema = z.object({
  orderId: z.string(),
  status: OrderStatusSchema,
  totalPrice: z.number().int(),
  items: z.array(OrderItemSchema),
});
export type PlacedOrder = z.infer<typeof PlacedOrderSchema>;

// The history row. `itemCount` rather than the lines themselves: a list of 50 orders does not
// need every line, and `GET /orders/:id` already serves them to the page that does.
export const OrderSummarySchema = z.object({
  id: z.string(),
  status: OrderStatusSchema,
  totalPrice: z.number().int(),
  itemCount: z.number().int(),
  createdAt: z.string(),
});
export type OrderSummary = z.infer<typeof OrderSummarySchema>;

export const OrderListSchema = z.array(OrderSummarySchema);
export type OrderList = z.infer<typeof OrderListSchema>;

export const OrderDetailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: OrderStatusSchema,
  totalPrice: z.number().int(),
  items: z.array(OrderItemSchema),
  createdAt: z.string(),
});
export type OrderDetail = z.infer<typeof OrderDetailSchema>;
