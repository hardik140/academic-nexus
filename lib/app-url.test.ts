import { afterEach, describe, expect, it } from "vitest";
import { getPublicAppUrl } from "@/lib/app-url";

const originalNodeEnv = process.env.NODE_ENV;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

describe("getPublicAppUrl", () => {
  it("normalizes a configured public URL", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://portal.example.com/";

    expect(getPublicAppUrl()).toBe("https://portal.example.com");
  });

  it("rejects localhost in production", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    expect(() => getPublicAppUrl()).toThrow(/cannot point to localhost/);
  });
});