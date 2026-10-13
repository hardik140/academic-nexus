import * as Sentry from "@sentry/nextjs";
import { browserSentryOptions } from "@/lib/observability/sentry-options";

// Global handlers (window.onerror, unhandledrejection) come with the SDK;
// every event is scrubbed and expected errors dropped (lib/observability/scrub.ts).
Sentry.init(browserSentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));

export const onRouterTransitionStart =
  Sentry.captureRouterTransitionStart;
