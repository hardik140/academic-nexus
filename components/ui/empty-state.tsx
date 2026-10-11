import { cn } from "@/lib/utils";

/**
 * A successful load that found nothing (M6.1). Only StateView renders it,
 * and only when the load succeeded — never while loading and never after a
 * failure, which would tell the user "there is nothing here" when the truth
 * is "we could not look" (owner decision D5; guarded by
 * tests/feedback-contract.test.ts). Plain content: not a live region.
 */

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** A way forward, such as a link to create the first record. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div data-empty-state="" className={cn("flex flex-col items-center justify-center gap-sm py-xl text-center", className)}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-outline">
        {/* An empty tray. */}
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
      <p className="text-body font-semibold text-on-surface">{title}</p>
      {description && <p className="max-w-[48ch] text-body-sm text-on-surface-variant">{description}</p>}
      {action && <div className="pt-xs">{action}</div>}
    </div>
  );
}
