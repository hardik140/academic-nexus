import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const supabaseConnectSrc = "https://*.supabase.co wss://*.supabase.co";

const cspDirectives = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: https://*.supabase.co https://lh3.googleusercontent.com`,
  `font-src 'self' data:`,
  `connect-src 'self' ${supabaseConnectSrc} https://*.ingest.sentry.io`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Report-Only: observes and would-be-block, but never actually blocks a
  // response yet. Flip to `Content-Security-Policy` once violations have
  // been watched for a few days via Sentry (see instrumentation-client.ts).
  { key: "Content-Security-Policy-Report-Only", value: cspDirectives },
];

const nextConfig: NextConfig = {
  // Enable experimental features for Next.js 15
  experimental: {
    // Server Actions are stable in Next.js 15
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  // No org/project/authToken until the user creates a Sentry project — the
  // plugin skips source-map upload gracefully in that case rather than
  // failing the build.
  widenClientFileUpload: true,
  disableLogger: true,
  automaticVercelMonitors: false,
});
