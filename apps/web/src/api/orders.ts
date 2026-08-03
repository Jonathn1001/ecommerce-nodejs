import { OrderDetailSchema, PlacedOrderSchema } from "@ecom/contracts";
import { request } from "./request";
import { API } from "./refresh";
import { HttpError } from "./errors";

// POST takes no body: the server places whatever is in the caller's cart, prices it from its
// own read-model, and clears the cart in the same transaction.
export const placeOrder = () =>
  request(`${API}/orders`, PlacedOrderSchema, { method: "POST" });

export const getOrder = (id: string) =>
  request(`${API}/orders/${encodeURIComponent(id)}`, OrderDetailSchema);

// Two of the three failures are ordinary and recoverable in one click. Rendering them as
// "something went wrong" would strand a user who could have fixed it.
export function describeCheckoutFailure(e: unknown): string {
  if (e instanceof HttpError && e.status === 400)
    return "Your cart is empty — it may have been placed in another tab.";
  if (e instanceof HttpError && e.status === 422)
    return "One of these products has no price yet. Remove it and try again.";
  return "Could not place the order. Try again.";
}
