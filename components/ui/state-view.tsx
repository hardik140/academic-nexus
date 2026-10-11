import { Alert } from "@/components/ui/alert";
import { EmptyState, type EmptyStateProps } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Button } from "@/components/ui/modal";
import type { AsyncResourceState } from "@/lib/async-resource";
import { classifyError, type ErrorKind } from "@/lib/feedback-error";
import { cn } from "@/lib/utils";

/**
 * Renders an async resource (hooks/use-async-resource.ts) as exactly one of
 * its four meanings (M6.1, owner decision D5):
 *
 *   loading          → LoadingState
 *   success + empty  → EmptyState
 *   success + data   → children(data)
 *   error            → ErrorState, with Try again
 *
 * The rule it exists for: a failed load is NEVER shown as empty. "Could not
 * load" and "there is nothing here" are different answers, and the second
 * one, wrongly given, makes a pending queue look finished.
 *
 * Two in-between cases keep what the user already has: a reload shows the
 * previous data (or empty result) marked busy; a reload that fails keeps
 * showing previous data, if there was any, beside an error Alert with Try
 * again. When the previous result was empty, a failed reload is an error,
 * not empty.
 *
 * The region carries aria-busy while loading. Loading is announced only
 * with `announceLoading` — pass it for a load the user asked for, never for
 * passive or background loading. Its status region is always mounted, and
 * outside the busy region, so the announcement is reliable.
 */

export type ViewKind = "loading" | "empty" | "data" | "error";

export interface ViewSelection {
  view: ViewKind;
  /** A load is in progress (a first load, or a reload over earlier data). */
  busy: boolean;
  /** A reload failed while earlier data is still shown. */
  staleError: boolean;
}

export function defaultIsEmpty(data: unknown): boolean {
  return data === null || (Array.isArray(data) && data.length === 0);
}

/**
 * Decides what the state means. Invalid combinations — an unknown status, or
 * "success" without data — are rejected as errors: never shown as empty, and
 * never passed to `children`.
 */
export function selectView<T>(state: AsyncResourceState<T>, isEmpty: (data: T) => boolean = defaultIsEmpty): ViewSelection {
  const s = state as { status: unknown; data: T | undefined };
  const failed: ViewSelection = { view: "error", busy: false, staleError: false };
  switch (s.status) {
    case "loading":
      if (s.data === undefined) return { view: "loading", busy: true, staleError: false };
      return { view: isEmpty(s.data) ? "empty" : "data", busy: true, staleError: false };
    case "success":
      if (s.data === undefined) return failed;
      return { view: isEmpty(s.data) ? "empty" : "data", busy: false, staleError: false };
    case "error":
      if (s.data !== undefined && !isEmpty(s.data)) return { view: "data", busy: false, staleError: true };
      return failed;
    default:
      return failed;
  }
}

export interface StateViewProps<T> {
  /** The resource; its `reload`, when present, is the default Try again. */
  state: AsyncResourceState<T> & { reload?: () => void };
  children: (data: T) => React.ReactNode;
  /** What to show for a successful load that found nothing. */
  empty: EmptyStateProps;
  isEmpty?: (data: T) => boolean;
  /** Overrides Try again (defaults to state.reload). */
  onRetry?: () => void;
  /** Overrides the classified error kind. */
  errorKind?: ErrorKind;
  loadingLabel?: string;
  /** Announce loading as a status message: only for a load the user asked for. */
  announceLoading?: boolean;
  className?: string;
}

export function StateView<T>({
  state,
  children,
  empty,
  isEmpty,
  onRetry = state.reload,
  errorKind,
  loadingLabel = "Loading…",
  announceLoading = false,
  className,
}: StateViewProps<T>) {
  const { view, busy, staleError } = selectView(state, isEmpty);
  const failure = view === "error" || staleError ? classifyError(state.error) : null;
  const retry = onRetry && (
    <Button variant="outline" size="sm" onClick={onRetry}>
      Try again
    </Button>
  );

  return (
    <>
      <p role="status" className="sr-only">
        {announceLoading && busy ? loadingLabel : ""}
      </p>
      <div aria-busy={busy || undefined} data-view={view} className={cn("space-y-md", className)}>
        {view === "loading" && <LoadingState label={loadingLabel} />}
        {busy && view !== "loading" && <LoadingState variant="inline" label="Refreshing…" />}
        <Alert tone="error" action={retry}>
          {staleError ? (
            <>
              This couldn&apos;t be refreshed. Showing what was loaded earlier.
            </>
          ) : null}
        </Alert>
        {view === "error" && (
          <ErrorState kind={errorKind ?? failure?.kind} reference={failure?.reference} onRetry={onRetry} />
        )}
        {view === "empty" && <EmptyState {...empty} />}
        {view === "data" && children(state.data as T)}
      </div>
    </>
  );
}
