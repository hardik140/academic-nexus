export const LEVEL_STYLE: Record<string, string> = {
  fatal: "bg-error text-on-error",
  error: "bg-error-container text-on-error-container",
  warning: "bg-warning-container text-on-warning-container",
  info: "bg-surface-container-high text-on-surface",
};

/** Says which of the three states the data is in, so an empty list is never mistaken for a healthy system. */
export function ProviderStatus({ result }: { result: { state: "ok" } | { state: "not-configured"; missing: string[] } | { state: "unavailable"; message: string } }) {
  if (result.state === "ok") {
    return (
      <p role="status" className="text-sm text-on-surface-variant">
        <span aria-hidden="true">●</span> Connected to Sentry.
      </p>
    );
  }
  if (result.state === "not-configured") {
    return (
      <div role="alert" className="rounded-2xl border border-outline-variant bg-surface-container p-md text-sm">
        <p className="font-semibold text-on-surface">Monitoring is not configured</p>
        <p className="text-on-surface-variant mt-xs">
          No crash data can be shown — this is not the same as no crashes. Set {result.missing.join(", ")} on the server (see OBSERVABILITY.md).
        </p>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-2xl border border-error bg-error-container p-md text-sm text-on-error-container">
      <p className="font-semibold">Crash data is unavailable</p>
      <p className="mt-xs">{result.message} Nothing below reflects the system&apos;s current health.</p>
    </div>
  );
}
