import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import {
  createAsyncResourceController,
  INITIAL_ASYNC_STATE,
  type AsyncLoader,
  type AsyncResourceController,
  type AsyncResourceState,
} from "@/lib/async-resource";

export type AsyncResource<T> = AsyncResourceState<T> & {
  /** Load again with the current dependencies. Stable across renders. */
  reload: () => void;
};

function sameDeps(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/**
 * Loads data for a client component and reports it as exactly one of
 * "loading" | "success" | "error" (see lib/async-resource.ts).
 *
 *   const refunds = useAsyncResource(() => listRefundRequests(), []);
 *   refunds.status === "loading" → skeleton
 *   refunds.status === "error"   → error with refunds.reload as Retry
 *   refunds.status === "success" → content, or the empty state if the data is empty
 *
 * The load runs on mount and whenever `deps` change. A change of `deps` resets
 * to loading with no data in the same render — the previous record's data is
 * never shown against the new one, not even for a frame. Results that arrive
 * after they have been superseded (a newer load, a dependency change, or
 * unmount) are discarded, and the superseded load's AbortSignal is aborted.
 */
export function useAsyncResource<T>(load: AsyncLoader<T>, deps: DependencyList): AsyncResource<T> {
  const [tracked, setTracked] = useState<{ deps: DependencyList; state: AsyncResourceState<T> }>(() => ({
    deps,
    state: INITIAL_ASYNC_STATE,
  }));

  // Adjusting state while rendering (react.dev: "Storing information from
  // previous renders"): React discards this render's output and re-renders
  // before committing, so the stale state is never painted.
  let current = tracked;
  if (!sameDeps(tracked.deps, deps)) {
    current = { deps, state: INITIAL_ASYNC_STATE };
    setTracked(current);
  }

  const loadRef = useRef(load);
  const controllerRef = useRef<AsyncResourceController | null>(null);

  // Always call the latest `load`, so an inline arrow (a new function every
  // render) does not restart the load — only `deps` do.
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = createAsyncResourceController<T>(
      (signal) => loadRef.current(signal),
      // By value, not identity: callers pass `deps` as an inline array, a new
      // object every render. A disposed controller never calls this at all.
      (state) => setTracked((prev) => (sameDeps(prev.deps, deps) ? { deps: prev.deps, state } : prev))
    );
    controllerRef.current = controller;
    controller.run();
    return () => controller.dispose();
    // `deps` is the caller's dependency list, forwarded verbatim — the same
    // contract as useEffect's own second argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => controllerRef.current?.run(), []);

  return { ...current.state, reload };
}
