"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UnavailableView, type UnavailableReason } from "@/components/portal/unavailable-view";
import type { DeviceSession } from "@/components/portal/device-list";
import { createClient } from "@/lib/supabase/client";
import { endMySessions, revokeMySession } from "@/lib/sessions/actions";

export function UnavailableClient(props: {
  reason: UnavailableReason;
  collegeName: string | null;
  message: string | null;
  expectedResumeAt: string | null;
  sessions: DeviceSession[];
  maxSessions: number | null;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (sessionId: string) => {
    if (pendingId) return;
    setPendingId(sessionId);
    setError(null);
    try {
      await revokeMySession(sessionId);
      router.refresh();
    } catch {
      setError("That device couldn't be signed out. Please try again.");
    } finally {
      setPendingId(null);
    }
  };

  // Middleware runs again on this navigation (an App Router transition still
  // requests the server), so the session is re-admitted now that a slot is
  // free or the college is back — or sent here again if it is not.
  const retry = () => {
    router.replace("/");
    router.refresh();
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await endMySessions("global");
    await createClient().auth.signOut();
    router.replace("/login");
  };

  return (
    <main className="min-h-screen bg-surface flex items-center justify-center p-md">
      <UnavailableView
        {...props}
        pendingId={pendingId}
        error={error}
        onRevoke={revoke}
        onRetry={retry}
        onSignOut={signOut}
        signingOut={signingOut}
      />
    </main>
  );
}
