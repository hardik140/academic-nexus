jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

jest.mock("@/lib/device", () => ({
  clientHeaders: async () => ({
    "x-nexus-client": "mobile-app",
    "x-nexus-device-id": "device-1",
    "x-nexus-device-label": "Pixel 8 · Android 15",
  }),
}));

import { supabase } from "@/lib/supabase";
import { apiPost, ApiError, onAccessRefused } from "@/lib/api";

const mockGetSession = supabase.auth.getSession as jest.Mock;

describe("apiPost", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = jest.fn();
  });

  it("throws without calling fetch when there is no active session", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    await expect(
      apiPost("/api/mobile/gatepass/apply", { destination: "Home" })
    ).rejects.toThrow("Not signed in.");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("sends a Bearer-authenticated POST and returns the parsed JSON body", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "token-123" } },
    });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ id: "gp-1" }),
    });

    const result = await apiPost("/api/mobile/gatepass/apply", { destination: "Home" });

    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:3000/api/mobile/gatepass/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-123",
        // Migration 054: the updated app identifies itself, so its sessions
        // are registered as "mobile" rather than "mobile-legacy".
        "x-nexus-client": "mobile-app",
        "x-nexus-device-id": "device-1",
        "x-nexus-device-label": "Pixel 8 · Android 15",
      },
      body: JSON.stringify({ destination: "Home" }),
    });
    expect(result).toEqual({ id: "gp-1" });
  });

  it("throws the server-provided error message on a non-ok response", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "token-123" } },
    });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests." }),
    });

    await expect(apiPost("/api/mobile/gatepass/apply", {})).rejects.toThrow(
      "Too many requests."
    );
  });

  it("falls back to a generic error message when the response body isn't JSON", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "token-123" } },
    });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    await expect(apiPost("/api/mobile/gatepass/apply", {})).rejects.toThrow(
      "Request failed (500)."
    );
  });

  it("carries the server's status and code on the error", async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: "token-123" } } });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Your college is under maintenance.", code: "COLLEGE_UNAVAILABLE" }),
    });
    const error = await apiPost("/api/mobile/gatepass/apply", {}).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "COLLEGE_UNAVAILABLE", message: "Your college is under maintenance." });
  });

  it("tells access listeners about a lifecycle or session refusal — and only those", async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: "token-123" } } });
    const listener = jest.fn();
    const unsubscribe = onAccessRefused(listener);
    for (const [code, notified] of [["SESSION_REVOKED", true], ["SESSION_LIMIT", true], ["COLLEGE_UNAVAILABLE", true], ["FORBIDDEN", false], [undefined, false]] as const) {
      listener.mockClear();
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "x", code }) });
      await apiPost("/api/mobile/x", {}).catch(() => undefined);
      expect(listener).toHaveBeenCalledTimes(notified ? 1 : 0);
    }
    unsubscribe();
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "x", code: "SESSION_REVOKED" }) });
    listener.mockClear();
    await apiPost("/api/mobile/x", {}).catch(() => undefined);
    expect(listener).not.toHaveBeenCalled();
  });
});
