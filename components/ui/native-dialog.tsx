"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

type NativeDialogProps = Omit<
  React.ComponentPropsWithoutRef<"dialog">,
  "open" | "onClose" | "onCancel" | "onClick" | "onPointerDown" | "children"
> & {
  /** Whether the dialog is open — the single source of truth. */
  open: boolean;
  /** Asks the caller to close: Escape, a click on the backdrop, or the browser closing it. */
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * A native modal <dialog> opened with showModal(), behind the Modal (M4)
 * and the portal's mobile navigation drawer (M5). The browser supplies the
 * modal behaviour: the top layer and its ::backdrop, an inert page behind
 * it, focus moved inside on open and returned to the opener on close, and
 * Escape. `open` stays the single source of truth: Escape and a click on the
 * backdrop ask the caller through onClose, and the dialog follows the prop.
 * Its motion is the caller's motion-dialog or motion-drawer class.
 *
 * On close it plays that exit showing its content as it last was while open
 * (callers usually clear the state behind that content in the same update),
 * inert so nothing in it can be used while it leaves, and is then unmounted,
 * so the content never keeps state between openings. Nothing waits on the
 * exit to decide whether the dialog is open.
 */
export function NativeDialog({ open, onClose, children, ...props }: NativeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);

  // What the dialog shows: the live children while open, the last open ones
  // while it closes, and null (nothing rendered) once it has closed.
  const [shown, setShown] = useState<{ children: React.ReactNode } | null>(open ? { children } : null);
  if (open && (shown === null || shown.children !== children)) {
    setShown({ children });
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        // Bring the dialog's style up to date first. Reopened while its exit
        // is ending, Chromium otherwise looks for the control to focus in
        // stale style, finds none, and leaves focus on no element.
        void getComputedStyle(dialog).display;
        dialog.showModal();
      }
      return;
    }
    if (dialog.open) dialog.close();
    // Unmount once the dialog's own exit (and its ::backdrop's) has played:
    // at once when nothing transitions, and not at all if it reopens first.
    let current = true;
    const exit = dialog
      .getAnimations({ subtree: true })
      .filter((a) => a.effect instanceof KeyframeEffect && a.effect.target === dialog);
    Promise.allSettled(exit.map((a) => a.finished)).then(() => {
      if (current) setShown(null);
    });
    return () => {
      current = false;
    };
  }, [open]);

  // The page behind does not scroll while the dialog is open.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!shown) return null;

  // Clicks on the ::backdrop are dispatched to the dialog itself, outside its box.
  const onBackdrop = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target !== e.currentTarget) return false;
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
  };

  return (
    // Escape, the keyboard route to the same dismissal, arrives as `cancel`.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      {...props}
      ref={dialogRef}
      inert={!open}
      onCancel={(e) => {
        // Escape: ask the caller instead of closing underneath it.
        e.preventDefault();
        onClose();
      }}
      onClose={(e) => {
        // The browser closed it without asking (it may refuse to let a page
        // keep cancelling Escape): tell the caller. `close` is queued, so it
        // can arrive after a quick reopen; only a dialog still closed counts.
        if (open && !e.currentTarget.open) onClose();
      }}
      onPointerDown={(e) => {
        pressStartedOnBackdrop.current = onBackdrop(e);
      }}
      onClick={(e) => {
        // Only a click that starts and ends on the backdrop dismisses, never
        // a text selection dragged out of the dialog.
        if (pressStartedOnBackdrop.current && onBackdrop(e)) onClose();
        pressStartedOnBackdrop.current = false;
      }}
    >
      {shown.children}
    </dialog>
  );
}
