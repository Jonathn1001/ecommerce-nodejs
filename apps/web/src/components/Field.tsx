import type { InputHTMLAttributes } from "react";

export function Field({
  label,
  error,
  ...rest
}: { label: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="datum text-xs uppercase text-[color:var(--color-muted)]">
        {label}
      </span>
      <input
        {...rest}
        className="h-11 rounded-md border border-[color:var(--color-line-strong)] bg-[color:var(--color-surface)] px-3"
      />
      {error ? (
        <span className="text-sm text-[color:var(--color-fail)]">{error}</span>
      ) : null}
    </label>
  );
}
