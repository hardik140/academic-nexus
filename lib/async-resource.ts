/**
 * The state machine behind hooks/use-async-resource.ts, kept free of React
 * so it can be unit-tested in plain Node.
 *
 * One rule it exists to enforce: a load that FAILS ends in "error", never in
 * "success" with empty data. Screens render "empty" only from
 * `status === "success"` — so "still loading" and "could not load" can never
 * be mistaken for "there is nothing here".
 */

export type AsyncResourceState<T> =
  | { status: "loading"; data: T | undefined; error: undefined }
  | { status: "success"; data: T; error: undefined }
  | { status: "error"; data: T | undefined; error: unknown };

export type AsyncLoader<T> = (signal: AbortSignal) => Promise<T>;

export const INITIAL_ASYNC_STATE = { status: "loading", data: undefined, error: undefined } as const;

/** Marks a load that was superseded before it started, so its loader never ran. */
const SKIPPED: unique symbol = Symbol("skipped");

export interface AsyncResourceController {
  /** Start a load. Any load still in flight is superseded: its signal is aborted and its result ignored. */
  run(): void;
  /** Stop for good: abort what is in flight and ignore every later result. */
  dispose(): void;
}

/**
 * `data` is carried across a reload and across a failure: while reloading,
 * or after a reload fails, it still holds the last successful result, so a
 * screen may keep showing it next to a loading or error indicator. A new
 * controller (the hook creates one whenever its dependencies change) starts
 * from no data, so one record's data is never shown as another's.
 */
export function createAsyncResourceController<T>(
  load: AsyncLoader<T>,
  onChange: (state: AsyncResourceState<T>) => void
): AsyncResourceController {
  let state: AsyncResourceState<T> = INITIAL_ASYNC_STATE;
  let latestRun = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: AsyncResourceState<T>) => {
    state = next;
    onChange(next);
  };

  return {
    run() {
      if (disposed) return;
      const runId = ++latestRun;
      inFlight?.abort();
      const abort = new AbortController();
      inFlight = abort;
      set({ status: "loading", data: state.data, error: undefined });

      // Promise.resolve().then(...) so a loader that throws synchronously is
      // handled exactly like one that rejects. A load superseded (or disposed)
      // before it starts is never invoked at all — no wasted request.
      Promise.resolve()
        .then<T | typeof SKIPPED>(() => (disposed || runId !== latestRun ? SKIPPED : load(abort.signal)))
        .then(
          (data) => {
            if (data === SKIPPED || disposed || runId !== latestRun) return;
            inFlight = null;
            set({ status: "success", data, error: undefined });
          },
          (error: unknown) => {
            if (disposed || runId !== latestRun) return;
            inFlight = null;
            set({ status: "error", data: state.data, error });
          }
        );
    },
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
    },
  };
}
