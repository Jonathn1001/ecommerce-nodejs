# Phase 3b — manual full-saga demo (real closed loop)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service `.env`s, images built.

1. `docker compose --profile app up -d`   # postgres, kafka, rabbitmq, redis + inventory, order, payment
2. Seed a product price + stock + cart, then place an order:
   - `curl -X POST localhost:3002/admin/catalog -d '{"productId":"p1","name":"Widget","price":500}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3001/inventory/stock -d '{"productId":"p1","quantity":10}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3002/cart/items -H 'x-user-id: u1' -d '{"productId":"p1","quantity":1}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3002/orders -H 'x-user-id: u1'`   # -> orderId
3. Watch it confirm: `curl localhost:3002/orders/<id>` → PENDING → AWAITING_PAYMENT → **CONFIRMED**.
   Reservation is CONSUMED: `curl localhost:3001/inventory/p1` (activeReservations drops; stock stays reserved).
4. Compensation: place an order whose **total ends in 01** (e.g. price 501) → the simulated
   gateway declines → order → **CANCELLED**, stock **released**.
5. `docker compose --profile app down`.

The automated cross-service full-saga (kill-a-broker chaos) is Phase 7.
