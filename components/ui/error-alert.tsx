"use client";

import { Alert } from "@/components/ui/alert";
import { SignInAgainLink } from "@/components/ui/sign-in-again";
import type { FeedbackError } from "@/lib/action-failure";

/**
 * A failed action, shown next to it (M6.5): an error Alert (role="alert",
 * no motion, never dismisses itself). When the session has ended it says so
 * and offers "Sign in again" in the same tab.
 *
 * Render it always, with `error` null while there is nothing to say, so its
 * live region exists before a message arrives (see components/ui/alert.tsx).
 * `error` is a FeedbackError from toFeedbackError(), or plain text the page
 * wrote itself (a validation message).
 */
export function ErrorAlert({
  error,
  onDismiss,
  className,
}: {
  error: FeedbackError | string | null | undefined;
  onDismiss?: () => void;
  className?: string;
}) {
  const message = typeof error === "string" ? error : error?.message;
  const session = typeof error === "object" && error !== null && error.session;
  return (
    <Alert tone="error" className={className} onDismiss={onDismiss} action={session ? <SignInAgainLink /> : undefined}>
      {message}
    </Alert>
  );
}
