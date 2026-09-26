import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui/modal";
import { StatsCard } from "@/components/ui/stats-card";
import { DataTableDemos, FormFieldDemos, ModalDemo } from "./demos";

/**
 * Development-only component gallery — the browser-verification surface for
 * the shared UI primitives (Checkpoint 3A).
 *
 * Three independent guards keep it out of any deployment:
 *   1. The `.dev.tsx` extension is a page extension only in the `next dev`
 *      phase (next.config.ts), so `next build` never treats this file as a
 *      route. scripts/check-no-dev-routes.mjs verifies a finished build.
 *   2. notFound() below if it is ever rendered with NODE_ENV=production.
 *   3. lib/supabase/middleware.ts only exempts /dev/ from the session check
 *      when NODE_ENV is "development".
 *
 * It renders the CURRENT primitives exactly as they are, with fictional
 * sample data. Nothing is fetched and no server action is imported.
 */
export const metadata: Metadata = {
  title: "Component gallery (development only)",
  robots: { index: false, follow: false },
};

const STATUSES = [
  "active", "pending", "approved", "rejected", "paid", "overdue", "partial",
  "present", "absent", "late", "excused", "planned", "closed", "reopened",
];

const COLOR_TOKENS = [
  "surface", "surface-container-lowest", "surface-container-low", "surface-container-high",
  "on-surface", "on-surface-variant", "outline", "outline-variant",
  "secondary", "error", "success", "warning", "info",
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} data-testid={`gallery-${id}`} className="space-y-md">
      <h2 id={`${id}-heading`} className="text-lg font-bold text-on-surface border-b border-outline-variant pb-xs">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function ComponentGalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="min-h-screen bg-surface p-lg">
      <div className="max-w-[80rem] mx-auto space-y-2xl">
        <header className="space-y-xs">
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Component gallery</h1>
          <p className="text-sm text-on-surface-variant">
            Development only — current primitives, unchanged, with fictional sample data.
          </p>
        </header>

        <Section id="colors" title="Color tokens">
          <ul className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-sm">
            {COLOR_TOKENS.map((token) => (
              <li key={token} className="text-xs text-on-surface-variant">
                <div
                  className="h-12 rounded-lg border border-outline-variant"
                  style={{ background: `var(--color-${token})` }}
                />
                <span className="block mt-xs font-mono">{token}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="typography" title="Typography">
          <div className="space-y-sm">
            <p className="text-2xl font-extrabold text-on-surface tracking-tight">Page title — text-2xl extrabold</p>
            <p className="text-sm font-bold text-on-surface">Section title — text-sm bold</p>
            <p className="text-sm text-on-surface">Body — text-sm on-surface</p>
            <p className="text-sm text-on-surface-variant">Secondary — text-sm on-surface-variant</p>
            <p className="text-xs text-outline">Muted — text-xs outline</p>
            <p className="text-[11px] text-outline">Caption — text-[11px] outline</p>
            <p className="font-mono text-sm text-on-surface">22CS041 · PAY-7Q2K · CS301</p>
          </div>
        </Section>

        <Section id="buttons" title="Buttons">
          <div className="flex flex-wrap items-center gap-sm">
            {(["primary", "secondary", "outline", "ghost", "destructive"] as const).map((variant) => (
              <Button key={variant} variant={variant}>{variant}</Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-sm">
            {(["sm", "md", "lg"] as const).map((size) => (
              <Button key={size} size={size}>Size {size}</Button>
            ))}
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        <Section id="form-fields" title="Form fields">
          <FormFieldDemos />
        </Section>

        <Section id="status-badges" title="Status badges">
          <div className="flex flex-wrap gap-sm">
            {STATUSES.map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
        </Section>

        <Section id="stats-cards" title="Stats cards">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
            <StatsCard label="Students" value={1284} icon="🎓" />
            <StatsCard label="Attendance" value="86%" color="success" progress={{ current: 86, max: 100 }} />
            <StatsCard label="Pending refunds" value={7} color="warning" trend={{ value: 12, direction: "up" }} />
            <StatsCard label="Overdue fees" value={23} color="error" subtitle="Across 3 programmes" />
          </div>
        </Section>

        <Section id="data-table" title="Data table">
          <DataTableDemos />
        </Section>

        <Section id="modal" title="Modal">
          <ModalDemo />
        </Section>
      </div>
    </main>
  );
}
