import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { HttpError } from "../api/errors";
import { getOrder } from "../api/orders";
import { listProducts } from "../api/products";
import { Badge } from "../components/Badge";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

export function Order() {
  const { id = "" } = useParams();
  const order = useQuery({ queryKey: ["order", id], queryFn: () => getOrder(id) });
  const products = useQuery({ queryKey: ["products"], queryFn: listProducts });

  if (order.isPending) return <Skeleton />;
  if (order.error instanceof HttpError && order.error.status === 404) {
    return (
      <div className="p-12 text-center">
        <h1 className="text-2xl">Order not found</h1>
        <Link to="/" className="datum mt-4 inline-block underline">
          Back to the catalogue
        </Link>
      </div>
    );
  }
  if (order.error) return <ErrorState error={order.error} />;

  // Names come from the catalogue, prices do NOT: an order carries the price it captured, and
  // an order outlives the product it references.
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl">Order placed</h1>
        <Badge>{order.data.status}</Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {order.data.items.map((i) => (
          <li
            key={i.productId}
            className="flex justify-between border-b border-[color:var(--color-line)] py-2"
          >
            <span>
              {byId.get(i.productId)?.name ?? i.productId}
              <span className="datum ml-2 text-[color:var(--color-muted)]">
                × {i.quantity}
              </span>
            </span>
            <Price minorUnits={i.unitPrice} />
          </li>
        ))}
      </ul>
      <p className="flex justify-between">
        <span className="datum text-xs uppercase text-[color:var(--color-muted)]">
          Total
        </span>
        <Price minorUnits={order.data.totalPrice} />
      </p>
      <Link to="/" className="datum underline">
        Continue shopping
      </Link>
    </div>
  );
}
