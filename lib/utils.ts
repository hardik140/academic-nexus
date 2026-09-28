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

/**
 * The other named tokens app/globals.css adds to Tailwind's scales (Stage 2).
 * Without them tailwind-merge misreads the classes: it takes `text-caption`
 * for a text COLOUR, so cn("text-caption", "text-error") would silently drop
 * the size; and it does not recognise `rounded-panel`, `shadow-menu` or
 * `ease-emphasized` at all, so they never override a conflicting class.
 * Kept in step with globals.css by tests/cn.test.ts.
 */
export const NAMED_TEXT = ["caption", "body-sm", "body", "emphasis", "section", "page-title", "metric"] as const;
export const NAMED_RADIUS = ["control", "panel", "dialog"] as const;
export const NAMED_SHADOW = ["panel", "menu", "dialog"] as const;
export const NAMED_EASE = ["emphasized"] as const;

/**
 * The semantic motion utilities app/globals.css defines with @utility
 * (Checkpoint 4, M1). Each is a complete transition — properties, duration
 * and easing — so it conflicts with every raw transition-, duration-, ease-
 * and transition-behaviour class. Kept in step with globals.css by
 * tests/cn.test.ts.
 */
export const MOTION_UTILITIES = ["feedback", "state", "dialog", "drawer"] as const;

const twMerge = extendTailwindMerge<"motion">({
  extend: {
    theme: {
      spacing: [...NAMED_SPACING],
      text: [...NAMED_TEXT],
      radius: [...NAMED_RADIUS],
      shadow: [...NAMED_SHADOW],
      ease: [...NAMED_EASE],
    },
    classGroups: {
      motion: [{ motion: [...MOTION_UTILITIES] }],
    },
    conflictingClassGroups: {
      motion: ["transition", "transition-behavior", "duration", "ease"],
    },
  },
});

const SEMANTIC_MOTION = new RegExp(`^(.*:)?motion-(?:${MOTION_UTILITIES.join("|")})$`);

/**
 * tailwind-merge's rule is "last class wins", so on its own a raw class
 * placed AFTER a motion utility — cn("motion-feedback", "transition-all") —
 * would survive beside it and let the stylesheet's order decide. A motion
 * utility is the contract, so it wins in either order: any raw transition
 * class with the same variants is dropped. Whether a class conflicts is
 * asked of tailwind-merge itself, so variants and arbitrary values are
 * judged exactly as it judges them.
 */
function keepSemanticMotion(merged: string): string {
  const classes = merged.split(" ");
  const variantPrefixes = new Set<string>();
  for (const name of classes) {
    const match = SEMANTIC_MOTION.exec(name);
    if (match) variantPrefixes.add(match[1] ?? "");
  }
  if (variantPrefixes.size === 0) return merged;

  return classes
    .filter((name) => {
      if (SEMANTIC_MOTION.test(name)) return true;
      for (const prefix of variantPrefixes) {
        const probe = `${prefix}motion-feedback`;
        if (twMerge(`${name} ${probe}`) === probe) return false;
      }
      return true;
    })
    .join(" ");
}

/** Merge Tailwind classes safely (handles conflicts, including named spacing and motion) */
export function cn(...inputs: ClassValue[]) {
  return keepSemanticMotion(twMerge(clsx(inputs)));
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
