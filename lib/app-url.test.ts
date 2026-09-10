import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicAppUrl } from "@/lib/app-url";

// vi.stubEnv rather than assigning process.env.NODE_ENV directly: the
// current @types/node declares NODE_ENV readonly, so the assignment does not
// type-check and was failing the build. stubEnv is vitest's supported way to
// do this and restores the value itself.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPublicAppUrl", () => {
  it("normalizes a configured public URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://portal.example.com/");

    expect(getPublicAppUrl()).toBe("https://portal.example.com");
  });

  it("rejects localhost in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");

    expect(() => getPublicAppUrl()).toThrow(/cannot point to localhost/);
  });
});