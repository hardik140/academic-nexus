import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { registerSession, revokeSession, signOutEverywhere } from "@/lib/session";

// Hoisted above the imports by babel-jest.
jest.mock("@/lib/supabase", () => ({
  supabase: { auth: { signOut: jest.fn() } },
}));
jest.mock("@/lib/api", () => ({
  apiPost: jest.fn(),
}));

const mockApiPost = apiPost as jest.Mock;
const mockSignOut = supabase.auth.signOut as jest.Mock;

describe("session registry client (migration 054)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("registers through POST /api/mobile/session and returns the server's admission as-is", async () => {
    const rejected = { state: "rejected", maxSessions: 1, sessions: [] };
    mockApiPost.mockResolvedValue(rejected);
    await expect(registerSession()).resolves.toEqual(rejected);
    expect(mockApiPost).toHaveBeenCalledWith("/api/mobile/session", {});
  });

  it("reports 'unavailable' when the server cannot be reached — never 'active'", async () => {
    mockApiPost.mockRejectedValue(new Error("Network request failed"));
    await expect(registerSession()).resolves.toEqual({ state: "unavailable" });
  });

  it("revokes one of the user's own sessions by id", async () => {
    mockApiPost.mockResolvedValue({ ok: true });
    await revokeSession("5e550000-0000-4000-8000-000000000001");
    expect(mockApiPost).toHaveBeenCalledWith("/api/mobile/session/revoke", { sessionId: "5e550000-0000-4000-8000-000000000001" });
  });

  it("ends the registry sessions with the same global scope signOut() uses, then signs out", async () => {
    mockApiPost.mockResolvedValue({ ok: true });
    await signOutEverywhere();
    expect(mockApiPost).toHaveBeenCalledWith("/api/mobile/session/end", { scope: "global" });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockApiPost.mock.invocationCallOrder[0]).toBeLessThan(mockSignOut.mock.invocationCallOrder[0]);
  });

  it("still signs out when recording the sign-out fails", async () => {
    mockApiPost.mockRejectedValue(new Error("offline"));
    await signOutEverywhere();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
