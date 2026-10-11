"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import type { FeedbackError } from "@/lib/action-failure";

/**
 * Asks before a consequential or destructive action (M6.3 / M6.7), on the
 * native-dialog Modal.
 *
 *   • Cancel has focus when it opens: pressing Enter by reflex cancels. The
 *     native `autofocus` attribute does it, so showModal()'s own focusing
 *     honours it (React's autoFocus runs before showModal() and would miss).
 *   • Confirm is the only way to proceed. While the action runs (`pending`)
 *     it is disabled and marked busy, and nothing dismisses the dialog:
 *     not Cancel, Close, Escape or the backdrop. If the browser closes it
 *     anyway (Chromium lets a second Escape through), it opens again.
 *   • A failure stays inside the dialog (`error`), with whatever the user
 *     typed into `children` still there; the caller closes it on success.
 *   • On close, the browser returns focus to the control that opened it. If
 *     that control has gone (the row was removed), focus goes to
 *     `returnFocusTo()` instead of the top of the document.
 */

/** How long after closing a vanished opener is still looked after. */
const FOCUS_WATCH_MS = 5000;

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Extra content: what is affected, or an input such as a reason. */
  children?: React.ReactNode;
  confirmLabel: string;
  /** Confirm's label while the action runs. */
  pendingLabel?: string;
  cancelLabel?: string;
  tone?: "destructive" | "default";
  pending: boolean;
  error?: FeedbackError | string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes if the control that opened the dialog is gone. */
  returnFocusTo?: () => HTMLElement | null;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  tone = "destructive",
  pending,
  error,
  onConfirm,
  onCancel,
  returnFocusTo,
}: ConfirmationDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const confirming = useRef(false);
  // Bumped to show the dialog again if the browser closed it mid-action.
  const [generation, setGeneration] = useState(0);

  // A new action may be confirmed once the previous one has settled.
  useEffect(() => {
    if (!pending) confirming.current = false;
  }, [pending, open]);

  // Closed, and the opener has gone — at once, or when the list it was in
  // reloads a moment later: put focus on `returnFocusTo()` rather than the
  // top of the document. The watch ends as soon as focus is somewhere real
  // other than the opener (the user moved on), and after a few seconds.
  const wasOpen = useRef(open);
  const watching = useRef(false);
  const returnFocusRef = useRef(returnFocusTo);
  useEffect(() => {
    returnFocusRef.current = returnFocusTo;
  });
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || !returnFocusRef.current) return;
    watching.current = true;
    const opener = document.activeElement;
    const stop = () => {
      watching.current = false;
      document.removeEventListener("focusin", onFocusIn);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target !== opener) stop();
    };
    document.addEventListener("focusin", onFocusIn);
    const timeout = window.setTimeout(stop, FOCUS_WATCH_MS);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, [open]);
  // Checked after every render: the opener's removal is a render.
  useEffect(() => {
    if (!watching.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target = returnFocusRef.current?.();
    if (target) {
      watching.current = false;
      target.focus();
    }
  });

  const requestClose = () => {
    if (!pending) {
      onCancel();
      return;
    }
    // Not while the action runs. If the browser has already closed it, open it again.
    if (bodyRef.current?.closest("dialog")?.open === false) setGeneration((g) => g + 1);
  };

  return (
    <Modal
      key={generation}
      open={open}
      onClose={requestClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button
            variant="outline"
            disabled={pending}
            onClick={requestClose}
            // The native attribute, set before showModal() runs its focusing steps.
            ref={(el) => el?.setAttribute("autofocus", "")}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "destructive" ? "destructive" : "primary"}
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => {
              if (pending || confirming.current) return;
              confirming.current = true;
              onConfirm();
            }}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </Button>
        </>
      }
    >
      <div ref={bodyRef} className="space-y-md">
        <ErrorAlert error={error} />
        {children}
      </div>
    </Modal>
  );
}
