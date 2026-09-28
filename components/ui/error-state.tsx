import { Button } from "@/components/ui/modal";
import type { ErrorKind } from "@/lib/feedback-error";
import { cn } from "@/lib/utils";

/**
 * Content that could not be loaded (M6.1). role="alert", so it is announced
 * when it appears. Appears immediately: an error has no entrance motion.
 *
 * The copy comes from `kind` (see lib/feedback-error.ts, classifyError). It
 * deliberately takes no Error object and prints no error message: a server
 * message can carry internal detail, and in production Next.js replaces it
 * with a generic one anyway. The only thing shown from the error is its
 * `reference` (Next.js's digest), so a report can be matched to server logs.
 *
 * Try again appears only where trying again can help: not for a permission
 * refusal, an expired session or something that does not exist.
 */

const COPY: Record<ErrorKind, { title: string; description: string; retryable: boolean }> = {
  load: { title: "This couldn't be loaded", description: "Something went wrong while loading it.", retryable: true },
  network: { title: "Couldn't reach the server", description: "Check your internet connection.", retryable: true },
  forbidden: { title: "You don't have access to this", description: "If you need it, ask your college administrator.", retryable: false },
  session: { title: "Your session has expired", description: "Please sign in again.", retryable: false },
  "not-found": { title: "This couldn't be found", description: "It may have been moved or removed.", retryable: false },
  unknown: { title: "Something went wrong", description: "If it keeps happening, contact your college administrator.", retryable: true },
};

export interface ErrorStateProps {
  kind?: ErrorKind;
  /** Overrides the kind's title; keep it free of server detail. */
  title?: string;
  /** Overrides the kind's description; keep it free of server detail. */
  description?: string;
  /** Shows Try again for a retryable kind. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Next.js's error digest. */
  reference?: string;
  /** A further way forward, such as a link back to the dashboard. */
  action?: React.ReactNode;
  className?: string;
}

export function ErrorState({ kind = "load", title, description, onRetry, retryLabel = "Try again", reference, action, className }: ErrorStateProps) {
  const copy = COPY[kind];
  const showRetry = Boolean(onRetry) && copy.retryable;
  return (
    <div role="alert" data-error-state={kind} className={cn("flex flex-col items-center justify-center gap-sm py-xl text-center", className)}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-error">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
      <p className="text-body font-semibold text-on-surface">{title ?? copy.title}</p>
      <p className="max-w-[48ch] text-body-sm text-on-surface-variant">{description ?? copy.description}</p>
      {reference && (
        <p className="text-caption text-outline">
          Reference: <span className="font-mono">{reference}</span>
        </p>
      )}
      {(showRetry || action) && (
        <div className="flex flex-wrap items-center justify-center gap-sm pt-xs">
          {showRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
