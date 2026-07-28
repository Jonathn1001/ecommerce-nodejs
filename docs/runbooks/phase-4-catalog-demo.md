# Phase 4 — manual demo (Catalog → Order projection)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service `.env`s, images built.

1. `docker compose --profile app up -d`   # + catalog on :3004
2. Create a product in Catalog:
   `curl -X POST localhost:3004/products -d '{"type":"ELECTRONICS","name":"Widget","price":500,"attributes":{"manufacturer":"Acme"}}' -H 'content-type: application/json'`  # -> productId
3. Watch it project into Order: `curl localhost:3002/orders/... ` — or seed a cart + place an order for that productId; the order prices from the **projected** value, no `/admin/catalog`.
4. Update the price: `curl -X PATCH localhost:3004/products/<id> -d '{"price":900}' -H 'content-type: application/json'` → a new order prices at 900.
5. Comments: `curl -X POST localhost:3004/products/<id>/comments -d '{"body":"nice"}' -H 'content-type: application/json'`; `curl localhost:3004/products/<id>/comments`.
6. Discount: `curl -X POST localhost:3004/discounts -d '{"code":"SAVE10","kind":"PERCENT","value":10,"minOrder":100,"maxUses":5,"maxPerUser":1,"expiresAt":"2030-01-01T00:00:00.000Z"}' -H 'content-type: application/json'`; `curl -X POST localhost:3004/discounts/SAVE10/apply -d '{"userId":"u1","orderTotal":1000}' -H 'content-type: application/json'` → `{"amount":100}` (service-local; NOT applied to checkout).
7. `docker compose --profile app down`.

Automated cross-service full-loop → Phase 7.
