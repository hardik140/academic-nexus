import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalShell } from "@/components/portal/portal-shell";
import { ShellHarnessPage } from "./harness";
import { SAMPLE_PROFILE } from "./sample";

/**
 * Development-only harness for the portal shell (Checkpoint 4, M5): the real
 * PortalShell around sample content, so its sidebar and mobile drawer can be
 * verified in a browser without a session (owner decision D3 keeps the real
 * portal out of reach). Guarded like the component gallery: `.dev.tsx` is a
 * route extension only under `next dev`, notFound() in production, and
 * scripts/check-no-dev-routes.mjs checks a finished build.
 *
 * A page, not a layout: a development-only layout would add a layout route
 * the production route types do not know, which breaks `next build`'s type
 * check whenever `next dev` has run first.
 */
export const metadata: Metadata = {
  title: "Portal shell (development only)",
  robots: { index: false, follow: false },
};

export default function ShellHarness() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <PortalShell profile={SAMPLE_PROFILE}>
      <ShellHarnessPage title="Shell harness" />
    </PortalShell>
  );
}
