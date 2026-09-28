import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found — Academic Nexus",
};

/**
 * No such page (M6.8). Not an alert: nothing failed that the user must act
 * on, so it is plain content with a way back.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-sm bg-surface p-lg text-center">
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-outline">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <h1 className="text-section text-on-surface">This page couldn&apos;t be found</h1>
      <p className="max-w-[48ch] text-body-sm text-on-surface-variant">
        The address may be mistyped, or the page may have been moved or removed.
      </p>
      <Link
        href="/"
        className="motion-feedback mt-xs inline-flex items-center rounded-control border border-border-control bg-surface-container-lowest px-md py-sm text-sm font-medium text-on-surface hover:bg-surface-container-high"
      >
        Go to the home page
      </Link>
    </main>
  );
}
