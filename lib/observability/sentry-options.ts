import type { BrowserOptions } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

/**
 * The browser SDK's options (instrumentation-client.ts). Disabled — nothing
 * is sent anywhere — unless NEXT_PUBLIC_SENTRY_DSN is set at build time.
 *
 * release is the build's commit (next.config.ts sets NEXT_PUBLIC_REDIS_BUILD_ID
 * to it), so a client report and a server report name the same release.
 * Both values are literal process.env reads: Next inlines only those.
 */
export function browserSentryOptions(dsn: string | undefined): BrowserOptions {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_REDIS_BUILD_ID,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend: (event, hint) => scrubEvent(event, hint.originalException),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  };
}
