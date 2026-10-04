import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";

// The development-only component gallery must never be reachable outside
// `next dev`. Two of its guards are code and are pinned here:
//   - next.config.ts only registers the `dev.tsx` page extension for the
//     development-server phase, so builds never see app/dev/**/page.dev.tsx;
//   - the middleware only skips the session check for /dev/ when NODE_ENV is
//     "development", and even then never creates a Supabase client.
// The third guard (the finished build contains no /dev route) is checked
// against real build output by scripts/check-no-dev-routes.mjs.

const createServerClient = vi.fn();

vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: unknown[]) => createServerClient(...args) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => undefined),
  RateLimitError: class RateLimitError extends Error {},
  RateLimiterUnavailableError: class RateLimiterUnavailableError extends Error {},
}));
vi.mock("@/lib/cache", () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher()),
}));

const { updateSession } = await import("@/lib/supabase/middleware");
const { pageExtensionsFor } = await import("../next.config");

function request(path: string) {
  return new NextRequest(new URL(path, "http://127.0.0.1:3100"));
}

beforeEach(() => {
  createServerClient.mockReset();
  createServerClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: null } }) },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development-only gallery: page extensions", () => {
  it("registers dev.tsx only for the development server phase", () => {
    expect(pageExtensionsFor(PHASE_DEVELOPMENT_SERVER)).toContain("dev.tsx");
  });

  it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])("never registers dev.tsx for %s", (phase) => {
    expect(pageExtensionsFor(phase)).not.toContain("dev.tsx");
    expect(pageExtensionsFor(phase)).toEqual(["tsx", "ts", "jsx", "js"]);
  });
});

describe("development-only gallery: middleware exemption", () => {
  it("in development, serves /dev/ without a session and without creating a Supabase client", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await updateSession(request("/dev/gallery"));
    expect(response.headers.get("location")).toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("in production, /dev/ gets the normal unauthenticated redirect to /login", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await updateSession(request("/dev/gallery"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
    expect(createServerClient).toHaveBeenCalled();
  });

  it("in development, the exemption does not extend to portal routes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await updateSession(request("/student/dashboard"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
  });

  it("in development, the exemption matches the /dev/ segment only, not look-alike paths", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await updateSession(request("/devices"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
  });
});
