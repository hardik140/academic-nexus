"use client";

import { useState } from "react";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { SessionEnforcementPanel } from "@/components/portal/session-enforcement-panel";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import { getSessionEnforcement, setSessionEnforcement } from "./actions";

export function SessionEnforcement() {
  const readiness = useAsyncResource(() => getSessionEnforcement(), []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);

  if (readiness.status === "error") {
    return (
      <ErrorState
        {...classifyError(readiness.error)}
        title="Session enforcement status couldn't be loaded"
        onRetry={readiness.reload}
        className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
      />
    );
  }
  if (readiness.status !== "success") return <LoadingState label="Loading session enforcement…" />;

  const onSwitch = async (mode: "register" | "enforce", reason: string) => {
    setPending(true);
    setError(null);
    try {
      await setSessionEnforcement(mode, reason);
      readiness.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Session enforcement couldn't be changed."));
    } finally {
      setPending(false);
    }
  };

  // Keyed on the mode: once a switch succeeds the panel starts fresh — the
  // confirmation closes and the reason field empties for the next change.
  return <SessionEnforcementPanel key={readiness.data.mode} readiness={readiness.data} onSwitch={onSwitch} pending={pending} error={error} />;
}
