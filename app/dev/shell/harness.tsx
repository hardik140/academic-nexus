"use client";

import { useState } from "react";

// Interactive half of the development-only portal-shell harness. Imported
// only by app/dev/shell/page.dev.tsx, which is not a route outside
// `next dev`. All content is fictional.

export function ShellHarnessPage({ title }: { title: string }) {
  const [clicks, setClicks] = useState(0);
  return (
    <div className="space-y-lg">
      <h1 className="text-page-title text-on-surface">{title}</h1>
      <div className="flex flex-wrap items-center gap-sm">
        <button
          type="button"
          onClick={() => setClicks((n) => n + 1)}
          className="motion-feedback rounded-control border border-border-control bg-surface-container-lowest px-md py-sm text-body text-on-surface hover:bg-surface-container-high"
        >
          Background action
        </button>
        <span className="text-body text-on-surface" data-testid="shell-log">
          Background clicks: {clicks}
        </span>
      </div>
      {/* Tall enough that the main area scrolls. */}
      <ol className="space-y-sm">
        {Array.from({ length: 30 }, (_, i) => (
          <li key={i} className="rounded-panel border border-outline-variant bg-surface-container-lowest p-md text-body text-on-surface">
            Semester review item {i + 1}: attendance, internal assessment and fee status reconciled.
          </li>
        ))}
      </ol>
    </div>
  );
}
