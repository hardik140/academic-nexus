jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";

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
});
