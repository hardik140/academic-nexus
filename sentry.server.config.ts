import * as Sentry from "@sentry/nextjs";

const dsn = typeof process !== "undefined"
  ? (process.env?.SENTRY_DSN || process.env?.NEXT_PUBLIC_SENTRY_DSN)
  : undefined;

if (dsn) {
  Sentry.init({
    dsn,
    enabled: true,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}
