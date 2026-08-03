import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProductType } from "@ecom/contracts";
import { listProducts } from "../api/products";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { ProductCard } from "../components/ProductCard";
import { Skeleton } from "../components/Skeleton";

const CATEGORIES: (ProductType | "ALL")[] = [
  "ALL",
  "MOTORBIKE",
  "ELECTRONICS",
  "FURNITURE",
  "CLOTHING",
];

export function Home() {
  const [filter, setFilter] = useState<ProductType | "ALL">("ALL");
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["products"],
    queryFn: listProducts,
  });

  if (isPending) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const shown = filter === "ALL" ? data : data.filter((p) => p.type === filter);

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            aria-pressed={filter === c}
            className="datum rounded-full border border-[color:var(--color-line)] px-3 py-1.5 text-xs uppercase"
          >
            {c}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState message="No products in the catalogue yet." />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {shown.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </>
  );
}
