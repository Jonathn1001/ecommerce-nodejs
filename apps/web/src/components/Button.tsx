import type { ButtonHTMLAttributes } from "react";

export function Button({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className="inline-flex h-11 items-center justify-center rounded-md border border-[color:var(--color-ink)] bg-[color:var(--color-ink)] px-5 text-sm text-[color:var(--color-paper)]"
    >
      {children}
    </button>
  );
}
