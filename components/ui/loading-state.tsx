import { cn } from "@/lib/utils";

/**
 * Content that is still loading (M6.1). Static, like the route loading
 * screen (M3): nothing pulses or spins, because a load is waiting, not
 * doing measurable work.
 *
 * Not a live region by default. The region being loaded carries aria-busy
 * (StateView sets it), and passive loading is never announced. `announce`
 * makes it a status message, for a load the user asked for — prefer
 * StateView's `announceLoading`, which keeps its live region mounted.
 */

const VARIANTS = {
  inline: "flex items-center gap-xs",
  section: "flex flex-col items-center justify-center gap-sm py-xl text-center",
  page: "flex min-h-[50vh] flex-col items-center justify-center gap-sm text-center",
} as const;

export interface LoadingStateProps {
  /** What is loading, in the user's words. */
  label?: string;
  variant?: keyof typeof VARIANTS;
  announce?: boolean;
  className?: string;
}

export function LoadingState({ label = "Loading…", variant = "section", announce = false, className }: LoadingStateProps) {
  return (
    <div role={announce ? "status" : undefined} data-loading-state="" className={cn(VARIANTS[variant], className)}>
      <svg
        aria-hidden="true"
        width={variant === "inline" ? 14 : 20}
        height={variant === "inline" ? 14 : 20}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-outline"
      >
        {/* A clock face: waiting, drawn still. */}
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      <p className="text-body-sm text-on-surface-variant">{label}</p>
    </div>
  );
}
