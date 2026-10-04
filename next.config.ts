import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { withSentryConfig } from "@sentry/nextjs";
import { execSync } from "node:child_process";

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

/**
 * The one route that is allowed to open a camera.
 *
 * `camera=()` above is an empty allowlist, which disables getUserMedia for
 * every origin INCLUDING this one — so with only that header the gate
 * scanner cannot acquire a stream on any browser, and the guard is told
 * "camera access was refused" with nothing they can do about it. Reading
 * the scanner's source does not reveal this; the header does.
 *
 * The fix stays local, per the rule that a page needing a capability does
 * not get it by weakening the policy globally: `camera=(self)` is scoped to
 * /security/scanner, which is behind the gate_security role check, and
 * every other route on the deployment keeps the empty allowlist. Microphone
 * and geolocation stay denied here too — the scanner needs neither.
 */
const scannerHeaders = [
  ...securityHeaders.filter((h) => h.key !== "Permissions-Policy"),
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

/**
 * Identifies this build to lib/redis-config.ts redisBuildId(), so cached
 * values written by one deployed build are never read by another during a
 * rollout (their shapes can differ). The commit SHA in CI, the local commit
 * otherwise; a timestamp only when neither exists. Not a secret.
 */
function redisBuildId(): string {
  const fromCi = process.env.GITHUB_SHA?.slice(0, 12);
  if (fromCi) return fromCi;
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return Date.now().toString(36);
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_REDIS_BUILD_ID: process.env.NEXT_PUBLIC_REDIS_BUILD_ID || redisBuildId(),
  },
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
      // Listed AFTER the catch-all deliberately: for a duplicated header
      // key the later matching rule is the one that survives, so this
      // re-grants the camera on exactly one path and nowhere else.
      {
        source: "/security/scanner",
        headers: scannerHeaders,
      },
    ];
  },
};

/**
 * Development-only routes — the component gallery under app/dev/ — are named
 * `page.dev.tsx`. `dev.tsx` is a page extension ONLY in the `next dev` phase,
 * so `next build` (and the OpenNext build that wraps it) never recognises
 * those files as routes: they are not compiled, not bundled, and there is
 * nothing at /dev/ to reach in any built deployment. Keyed on the phase
 * rather than NODE_ENV so that a mis-set NODE_ENV during a build cannot pull
 * them in. scripts/check-no-dev-routes.mjs verifies a finished build.
 */
const PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

export function pageExtensionsFor(phase: string): string[] {
  return phase === PHASE_DEVELOPMENT_SERVER ? ["dev.tsx", ...PAGE_EXTENSIONS] : PAGE_EXTENSIONS;
}

export default function config(phase: string): NextConfig {
  const resolved: NextConfig = { ...nextConfig, pageExtensions: pageExtensionsFor(phase) };

  return process.env.ENABLE_SENTRY === "true"
    ? withSentryConfig(resolved, {
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        silent: true,
        widenClientFileUpload: true,
        disableLogger: true,
        automaticVercelMonitors: false,
      })
    : resolved;
}

