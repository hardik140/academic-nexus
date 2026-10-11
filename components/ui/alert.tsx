"use client";

import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * An inline message about something that just happened, next to the thing it
 * is about (M6.1). Four tones on the Stage 2 container tokens (each pair at
 * least 6.4:1):
 *
 *   • error   → role="alert": announced at once. Appears immediately, with no
 *               motion.
 *   • success, info, warning → role="status": announced politely. Fades in
 *               with motion-appear (opacity only; 0ms with reduced motion).
 *
 * It never dismisses itself: there is no timer here, and a message leaves
 * only when the caller clears it, or when the user presses Dismiss (shown
 * when `onDismiss` is given).
 *
 * Keep the Alert rendered and pass no message while there is nothing to say:
 *
 *   <Alert tone="success" onDismiss={() => setSaved(null)}>{saved}</Alert>
 *
 * The live region then exists before the message arrives, which is what
 * makes screen readers announce a status message reliably (a status region
 * inserted already holding its text often is not read). While empty it takes
 * no space. When Dismiss removes the message, focus stays at the Alert's
 * place instead of falling back to the top of the document.
 *
 * The tone is never carried by colour or icon alone: its name is part of
 * the announced text ("Error: …"), and each tone has its own icon shape.
 */

export type AlertTone = "success" | "info" | "warning" | "error";

const TONES: Record<AlertTone, { label: string; box: string; icon: string }> = {
  success: { label: "Success", box: "border-success/40 bg-success-container text-on-success-container", icon: "text-success" },
  info: { label: "Information", box: "border-info/40 bg-info-container text-on-info-container", icon: "text-info" },
  warning: { label: "Warning", box: "border-warning/40 bg-warning-container text-on-warning-container", icon: "text-warning" },
  error: { label: "Error", box: "border-error/40 bg-error-container text-on-error-container", icon: "text-error" },
};

export interface AlertProps {
  tone: AlertTone;
  /** A short summary, shown in bold above the message. */
  title?: React.ReactNode;
  /** The message. Nothing (null, undefined, false or "") leaves the Alert empty. */
  children?: React.ReactNode;
  /** A follow-up control, such as Try again. */
  action?: React.ReactNode;
  /** Shows a Dismiss button, which calls this. */
  onDismiss?: () => void;
  /**
   * Move focus to the message when it appears. For a result that replaces
   * the control the user was on — a form that closes once submitted — so
   * focus lands on the outcome instead of the top of the document. Never
   * for passive messages.
   */
  focusOnShow?: boolean;
  /** Layout classes for the message (margins, width). Not applied while empty. */
  className?: string;
}

function hasContent(node: React.ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== "";
}

export function Alert({ tone, title, children, action, onDismiss, focusOnShow = false, className }: AlertProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const dismissedWithFocus = useRef(false);
  const hasMessage = hasContent(title) || hasContent(children);
  const { label, box, icon } = TONES[tone];

  // Dismiss removed the button that had focus: keep focus where the message
  // was. And a message asked to take focus takes it when it appears.
  useLayoutEffect(() => {
    if (!hasMessage && dismissedWithFocus.current) {
      dismissedWithFocus.current = false;
      regionRef.current?.focus();
    }
    if (hasMessage && focusOnShow) regionRef.current?.focus();
  }, [hasMessage, focusOnShow]);

  const toneName = <span className="sr-only">{label}: </span>;

  return (
    <div
      ref={regionRef}
      role={tone === "error" ? "alert" : "status"}
      tabIndex={-1}
      // Empty: out of the layout but still in the accessibility tree, so it
      // stays a live region. Focus lands here only after Dismiss, never by Tab.
      className={cn("outline-none", hasMessage ? className : "sr-only")}
    >
      {hasMessage && (
        <div
          data-tone={tone}
          className={cn(
            "flex items-start gap-sm rounded-panel border p-md text-body",
            box,
            tone !== "error" && "motion-appear"
          )}
        >
          <ToneIcon tone={tone} className={cn("mt-[2px] shrink-0", icon)} />
          <div className="min-w-0 flex-1 space-y-xs">
            {hasContent(title) && (
              <p className="font-semibold">
                {toneName}
                {title}
              </p>
            )}
            {hasContent(children) && (
              <div>
                {!hasContent(title) && toneName}
                {children}
              </div>
            )}
            {action && <div className="pt-xs">{action}</div>}
          </div>
          {onDismiss && (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                dismissedWithFocus.current = e.currentTarget === document.activeElement;
                onDismiss();
              }}
              className="motion-feedback -m-xs shrink-0 rounded-control p-xs hover:bg-current/10"
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A distinct shape per tone: check, "i", triangle, cross. */
function ToneIcon({ tone, className }: { tone: AlertTone; className?: string }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {tone === "success" && (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </>
      )}
      {tone === "info" && (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </>
      )}
      {tone === "warning" && (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      )}
      {tone === "error" && (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m15 9-6 6" />
          <path d="m9 9 6 6" />
        </>
      )}
    </svg>
  );
}
