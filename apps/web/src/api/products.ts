import { z } from "zod";
import { ProductDetailSchema, ProductListItemSchema } from "@ecom/contracts";
import { request } from "./request";

// Every gateway call goes under /api, which the proxy strips. Rooted at /products these paths
// would shadow the storefront's own /products/:id page — the proxy answers first, so a hard
// refresh on a product returns JSON instead of the app.
const API = "/api";

// GET /products takes NO parameters — Catalog serves the whole catalogue in one response
// (findMany with no take/skip). Sending ?limit= would imply a pagination that does not exist.
export const listProducts = () =>
  request(`${API}/products`, z.array(ProductListItemSchema));

export const getProduct = (id: string) =>
  request(`${API}/products/${encodeURIComponent(id)}`, ProductDetailSchema);
