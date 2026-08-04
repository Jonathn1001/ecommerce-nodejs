import { OrderDetailSchema, OrderListSchema, PlacedOrderSchema } from "@ecom/contracts";
import { request } from "./request";
import { API } from "./refresh";
import { HttpError } from "./errors";

// POST takes no body: the server places whatever is in the caller's cart, prices it from its
// own read-model, and clears the cart in the same transaction.
export const placeOrder = () =>
  request(`${API}/orders`, PlacedOrderSchema, { method: "POST" });

export const getOrder = (id: string) =>
  request(`${API}/orders/${encodeURIComponent(id)}`, OrderDetailSchema);

// Summaries, not details: the list carries a line COUNT, and the detail endpoint serves lines
// to the page that needs them.
export const listOrders = () => request(`${API}/orders`, OrderListSchema);

// Two of the three failures are ordinary and recoverable in one click. Rendering them as
// "something went wrong" would strand a user who could have fixed it.
//
// `nameFor` joins the id Order returns against the catalogue the caller already has. It is
// optional and defaults to "no name": the catalogue is a cache, and an order can reference a
// product it no longer holds, so a missing name degrades the message rather than the flow.
export function describeCheckoutFailure(
  e: unknown,
  nameFor: (id: string) => string | undefined = () => undefined
): string {
  if (e instanceof HttpError && e.status === 400)
    return "Your cart is empty — it may have been placed in another tab.";
  if (e instanceof HttpError && e.status === 422) {
    const id = productIdOf(e.body);
    const name = id === undefined ? undefined : nameFor(id);
    return name
      ? `${name} has no price yet. Remove it and try again.`
      : "One of these products has no price yet. Remove it and try again.";
  }
  return "Could not place the order. Try again.";
}

function productIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("productId" in body))
    return undefined;
  const id = (body as { productId: unknown }).productId;
  return typeof id === "string" ? id : undefined;
}
