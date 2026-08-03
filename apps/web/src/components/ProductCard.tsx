import { Link } from "react-router";
import type { ProductListItem } from "@ecom/contracts";
import { Badge } from "./Badge";
import { Card } from "./Card";
import { Price } from "./Price";
import { Silhouette } from "./Silhouette";

export function ProductCard({ product }: { product: ProductListItem }) {
  return (
    <Link to={`/products/${product.id}`}>
      <Card>
        <div className="relative flex aspect-[4/3] items-center justify-center bg-[color:var(--color-surface-2)]">
          <div className="absolute left-3 top-3">
            <Badge>{product.type}</Badge>
          </div>
          <Silhouette type={product.type} />
        </div>
        <div className="flex flex-col gap-1 p-4">
          <span className="text-[15px] font-medium">{product.name}</span>
          <Price minorUnits={product.price} />
        </div>
      </Card>
    </Link>
  );
}
