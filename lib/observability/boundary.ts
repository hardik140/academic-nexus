import * as Sentry from "@sentry/nextjs";

/**
 * Reports an error an error boundary caught (app/global-error.tsx,
 * app/(portal)/error.tsx). A boundary-caught render error never reaches
 * window.onerror in production, so this is its only report.
 *
 * An error with a digest was thrown on the server: onRequestError
 * (instrumentation.ts) already reported it there, with the real message, so
 * reporting it again here would count one failure twice.
 */
export function reportBoundaryError(error: Error & { digest?: string }, boundary: "portal" | "global"): void {
  if (error.digest) return;
  Sentry.captureException(error, { tags: { boundary } });
}
