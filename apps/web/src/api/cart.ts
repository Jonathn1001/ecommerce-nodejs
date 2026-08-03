import { z } from "zod";
import { CartSchema } from "@ecom/contracts";
import { request } from "./request";
import { API } from "./refresh";

// Every mutation answers 200 with a small JSON body — none of them is 204, so parsing is
// safe. Schemas rather than z.unknown(): a mutation that silently starts answering something
// else should fail here, not three screens later.
const AddedSchema = z.object({ productId: z.string() });
const SetSchema = z.object({ productId: z.string(), quantity: z.number().int() });

export const getCart = () => request(`${API}/cart`, CartSchema);

// POST INCREMENTS an existing line. PATCH SETS it, and 0 removes. A stepper must PATCH —
// built on POST it would add to the line instead of replacing it, doubling on every click.
export const addItem = (productId: string, quantity: number) =>
  request(`${API}/cart/items`, AddedSchema, {
    method: "POST",
    body: { productId, quantity },
  });

// 404 `not in cart` if the line is already gone — treat as success, the end state matches.
export const setQuantity = (productId: string, quantity: number) =>
  request(`${API}/cart/items/${encodeURIComponent(productId)}`, SetSchema, {
    method: "PATCH",
    body: { quantity },
  });

export const removeItem = (productId: string) =>
  request(`${API}/cart/items/${encodeURIComponent(productId)}`, AddedSchema, {
    method: "DELETE",
  });
