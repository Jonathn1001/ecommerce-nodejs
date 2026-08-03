import type { ReactNode } from "react";

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[var(--shadow-1)]">
      {children}
    </div>
  );
}
