"use client";

import "./globals.css";
import { ErrorState } from "@/components/ui/error-state";
import { classifyError } from "@/lib/feedback-error";

/**
 * The last resort (M6.8): the root layout itself failed. It replaces that
 * layout, so it renders its own document and brings its own styles (Next.js
 * does not apply the root layout's to it). Safe copy only, the digest as a
 * reference, and Try again, which re-fetches and re-renders.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { reference } = classifyError(error);
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface">
        <title>Something went wrong — Academic Nexus</title>
        <main className="flex min-h-screen items-center justify-center p-lg">
          <ErrorState
            kind="unknown"
            title="Academic Nexus couldn't be loaded"
            reference={reference}
            onRetry={retry}
            action={
              // A full page load, not a client navigation: the app around it is what failed.
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              <a
                href="/"
                className="motion-feedback inline-flex items-center rounded-control px-sm py-xs text-sm font-medium text-secondary hover:bg-surface-container-high"
              >
                Go to the home page
              </a>
            }
          />
        </main>
      </body>
    </html>
  );
}
