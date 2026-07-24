# Phase 3c — manual demo (SSE + async webhook + refund)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service `.env`s, images built.

1. `docker compose --profile app up -d`
2. Seed price + stock + cart, place an order whose total ends in **99** (async path):
   - `curl -X POST localhost:3002/admin/catalog -d '{"productId":"p1","name":"Widget","price":599}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3001/inventory/stock -d '{"productId":"p1","quantity":10}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3002/cart/items -H 'x-user-id: u1' -d '{"productId":"p1","quantity":1}' -H 'content-type: application/json'`
   - `ORDER=$(curl -sX POST localhost:3002/orders -H 'x-user-id: u1' | jq -r .orderId)`
3. Watch the live stream: `curl -N localhost:3002/orders/$ORDER/stream`
   → `PENDING` → `AWAITING_PAYMENT` … then it **waits** (Payment is PROCESSING, no event).
4. Resolve the async payment: `curl -X POST localhost:3003/webhooks/payment -d "{\"orderId\":\"$ORDER\",\"outcome\":\"SUCCEEDED\"}" -H 'content-type: application/json'`
   → the stream emits **CONFIRMED** and closes; reservation is CONSUMED.
5. Refund: `curl -X POST localhost:3003/admin/payments/$ORDER/refund`
   → Payment `REFUNDED`; `payment.refunded` emitted (no consumer this slice).
6. Compensation variant: an order ending in **01** with `outcome:"FAILED"` (or a sync %100==1) → `CANCELLED`, stock released.
7. `docker compose --profile app down`.

Order-side auto-cancel on a never-arriving webhook is Phase 7.
