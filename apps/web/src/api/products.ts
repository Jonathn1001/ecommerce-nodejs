import { z } from "zod";
import { ProductDetailSchema, ProductListItemSchema } from "@ecom/contracts";
import { request } from "./request";

// GET /products takes NO parameters — Catalog serves the whole catalogue in one response
// (findMany with no take/skip). Sending ?limit= would imply a pagination that does not exist.
export const listProducts = () => request("/products", z.array(ProductListItemSchema));

export const getProduct = (id: string) =>
  request(`/products/${encodeURIComponent(id)}`, ProductDetailSchema);
