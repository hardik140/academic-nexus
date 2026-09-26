import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The named spacing steps app/globals.css defines as --spacing-<name>.
 * tailwind-merge only knows Tailwind's numeric spacing scale, so without
 * these it treats `p-md` and `p-lg` as unrelated classes, keeps both, and the
 * stylesheet's order — not the caller — decides which padding wins. Kept in
 * step with globals.css by tests/cn.test.ts.
 */
export const NAMED_SPACING = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"] as const;

const twMerge = extendTailwindMerge({
  extend: { theme: { spacing: [...NAMED_SPACING] } },
});

/** Merge Tailwind classes safely (handles conflicts, including named spacing) */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format currency */
export function formatCurrency(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

/** Format date */
export function formatDate(
  date: string | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(date));
}

/** Format percentage */
export function formatPct(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/** Get user initials from full name */
export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
