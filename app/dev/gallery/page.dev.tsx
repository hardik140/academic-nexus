import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui/modal";
import { StatsCard } from "@/components/ui/stats-card";
import { PlacementFunnelChart } from "@/components/charts/placement-funnel-chart";
import Loading from "@/app/loading";
import { AsyncResourceDemo, ButtonFormDemo, DataTableDemos, FormFieldDemos, ModalDemo, MotionUtilityDemos, StatusChangeDemo } from "./demos";

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
 * It renders the current primitives and the Stage 2 design tokens with
 * fictional sample data. Nothing is fetched and no server action is imported.
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
  "on-surface", "on-surface-variant", "outline", "outline-variant", "border-control",
  "secondary", "focus-ring",
  "success", "success-container", "warning", "warning-container",
  "info", "info-container", "error", "error-container", "neutral", "neutral-container",
];

const TYPE_ROLES = [
  { role: "Caption", className: "text-caption text-outline", size: "12px" },
  { role: "Secondary", className: "text-body-sm text-on-surface-variant", size: "13px" },
  { role: "Body / table", className: "text-body text-on-surface", size: "14px" },
  { role: "Emphasis", className: "text-emphasis font-medium text-on-surface", size: "16px" },
  { role: "Section title", className: "text-section text-on-surface", size: "18px" },
  { role: "Page title", className: "text-page-title text-on-surface", size: "24px" },
  { role: "Dashboard number", className: "text-metric text-on-surface tabular-nums", size: "30px" },
];

const LIFECYCLE = ["planned", "active", "closed", "reopened"];

const CHARTS = [1, 2, 3, 4, 5, 6];

// Fictional sample counts for the funnel chart.
const SAMPLE_FUNNEL = [
  { name: "Eligible", value: 420 },
  { name: "Applied", value: 310 },
  { name: "Shortlisted", value: 180 },
  { name: "Interviewed", value: 96 },
  { name: "Placed", value: 58 },
];

const MOTION_TOKENS = [
  "--duration-instant", "--duration-fast", "--duration-normal", "--duration-slow",
  "--ease-out", "--ease-in-out", "--ease-emphasized",
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
            Development only — current primitives on the Stage 2 design tokens, with fictional sample data.
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
          <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-md gap-y-sm items-baseline">
            {TYPE_ROLES.map(({ role, className, size }) => (
              <div key={role} className="contents">
                <dt className="text-caption text-outline">
                  {role} · <span className="tabular-nums">{size}</span>
                </dt>
                <dd className={className}>{role === "Dashboard number" ? "1,284" : "Semester 5 attendance register"}</dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-caption text-outline">Identifier · mono</dt>
              <dd className="font-mono text-body text-on-surface">22CS041 · PAY-7Q2K · CS301</dd>
            </div>
          </dl>
        </Section>

        <Section id="lifecycle" title="Academic-period lifecycle">
          <div className="flex flex-wrap gap-sm">
            {LIFECYCLE.map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
          <p className="text-body-sm text-on-surface-variant">
            Closed means read-only, not failed: neutral with a lock.
          </p>
        </Section>

        <Section id="surfaces" title="Radius and elevation">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="rounded-panel border border-outline-variant bg-surface-container-lowest p-md">
              <p className="text-body font-semibold text-on-surface">Panel</p>
              <p className="text-body-sm text-on-surface-variant">radius-panel 12px · 1px border · no shadow</p>
            </div>
            <div className="rounded-control border border-outline-variant bg-surface-container-lowest p-md shadow-menu">
              <p className="text-body font-semibold text-on-surface">Menu</p>
              <p className="text-body-sm text-on-surface-variant">radius-control 8px · shadow-menu</p>
            </div>
            <div className="rounded-dialog border border-outline-variant bg-surface-container-lowest p-md shadow-dialog">
              <p className="text-body font-semibold text-on-surface">Dialog</p>
              <p className="text-body-sm text-on-surface-variant">radius-dialog 16px · shadow-dialog</p>
            </div>
          </div>
        </Section>

        <Section id="charts" title="Chart colours">
          <ul className="grid grid-cols-3 md:grid-cols-6 gap-sm">
            {CHARTS.map((n) => (
              <li key={n} className="text-caption text-on-surface-variant">
                <div className="h-8 rounded-control" style={{ background: `var(--color-chart-${n})` }} />
                <span className="block mt-xs font-mono">chart-{n}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="motion" title="Motion tokens">
          <ul className="flex flex-wrap gap-sm">
            {MOTION_TOKENS.map((name) => (
              <li key={name} className="font-mono text-caption text-on-surface-variant border border-outline-variant rounded-control px-sm py-xs">
                {name}
              </li>
            ))}
          </ul>
          <p className="text-body-sm text-on-surface-variant">
            Consumed through the motion utilities below. With reduced motion requested, the durations are 0ms and animations stop.
          </p>
        </Section>

        <Section id="motion-utilities" title="Motion utilities">
          <MotionUtilityDemos />
        </Section>

        <Section id="loading-screen" title="Route loading screen (app/loading.tsx)">
          {/* The real component, clipped to a panel: its min-h-screen becomes the panel's height. */}
          <div data-testid="loading-screen" className="h-64 overflow-hidden rounded-panel border border-outline-variant [&>div]:min-h-full [&>div]:h-full">
            <Loading />
          </div>
        </Section>

        <Section id="funnel-chart" title="Placement funnel chart (never animated)">
          <div data-testid="funnel-chart" className="rounded-panel border border-outline-variant bg-surface-container-lowest p-md">
            <PlacementFunnelChart stages={SAMPLE_FUNNEL} />
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
          <StatusChangeDemo />
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

        <Section id="button-form" title="Button inside a form">
          <ButtonFormDemo />
        </Section>

        <Section id="async-resource" title="useAsyncResource">
          <AsyncResourceDemo />
        </Section>
      </div>
    </main>
  );
}
