"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ErrorState } from "@/components/ui/error-state";
import { classifyError } from "@/lib/feedback-error";
import { reportBoundaryError } from "@/lib/observability/boundary";

/**
 * A portal page that failed to render (M6.8): shown inside the portal shell,
 * so the sidebar and header stay usable. The copy comes from the error's
 * kind, never its message — in production Next.js replaces a server error's
 * message anyway — and the digest is shown as a reference so a report can be
 * matched to the server logs. Try again re-fetches and re-renders the page
 * (retry(), Next.js 16.3). An expired session offers "Sign in again" instead.
 */
export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { kind, reference } = classifyError(error);
  useEffect(() => reportBoundaryError(error, "portal"), [error]);
  return (
    <ErrorState
      kind={kind}
      title={kind === "load" ? "This page couldn't be loaded" : undefined}
      reference={reference}
      onRetry={retry}
      action={
        kind === "session" ? undefined : (
          <Link
            href="/"
            className="motion-feedback inline-flex items-center rounded-control px-sm py-xs text-sm font-medium text-secondary hover:bg-surface-container-high"
          >
            Go to your dashboard
          </Link>
        )
      }
      className="min-h-[50vh]"
    />
  );
}
