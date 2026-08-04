import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { listOrders } from "../api/orders";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

// This page and the API it reads share a name and cannot collide: the browser calls /api/orders
// and the router owns /orders, which is the whole point of 8a's prefix decision.
export function Orders() {
  const orders = useQuery({ queryKey: ["orders"], queryFn: listOrders });

  if (orders.isPending) return <Skeleton />;
  if (orders.error)
    return <ErrorState error={orders.error} onRetry={() => orders.refetch()} />;
  if (orders.data.length === 0)
    return <EmptyState message="No orders yet — placing one starts the pipeline." />;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl">Your orders</h1>
      <ul className="flex flex-col">
        {orders.data.map((o) => (
          <li key={o.id} className="border-b border-[color:var(--color-line)]">
            <Link
              to={`/orders/${o.id}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span className="datum text-sm">{o.id}</span>
              <span className="datum text-xs text-[color:var(--color-muted)]">
                {o.itemCount} items
              </span>
              <Badge>{o.status}</Badge>
              <Price minorUnits={o.totalPrice} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
