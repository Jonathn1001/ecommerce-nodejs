import type { ProductType } from "@ecom/contracts";

const PATHS: Record<ProductType, string> = {
  ELECTRONICS: "M8 8h48v30H8zM4 44h56M26 38v6M38 38v6",
  CLOTHING: "M24 6l8 6 8-6 12 8-6 8-6-3v18H24V19l-6 3-6-8z",
  FURNITURE: "M14 24V12a6 6 0 016-6h24a6 6 0 016 6v12M10 24h44v10H10zM14 34v8M50 34v8",
  MOTORBIKE: "M15 34l10-16h16l6 8M25 18l-4-6h10M41 18l16 16M31 34h20",
};
const FALLBACK = "M10 10h44v28H10z";

export function Silhouette({ type }: { type: ProductType }) {
  const d = PATHS[type] ?? FALLBACK;
  return (
    <svg
      viewBox="0 0 64 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="w-1/2 text-[color:var(--color-ink-soft)]"
    >
      <path d={d} />
    </svg>
  );
}
