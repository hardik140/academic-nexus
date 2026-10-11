"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { addToast, dismissToast, elapse, EMPTY_QUEUE, type ToastQueue, type ToastTone } from "@/lib/toast-queue";
import { cn } from "@/lib/utils";

/**
 * Toasts (M6.2): brief, low-stakes confirmations with no better place to
 * appear — "Invitation resent". Never the only record of a consequential
 * outcome (that is a persistent Alert next to the form), and never an error
 * (an error stays next to what failed). Queue rules: lib/toast-queue.ts.
 *
 *   const toast = useToast();
 *   toast.success("Invitation resent to asha@example.edu");
 *
 * Accessibility:
 *   • one live region, mounted with the provider — before any toast — so
 *     each toast is announced when it is added. It announces additions only:
 *     a duplicate restarting its time, or a toast leaving, is not re-read;
 *   • a toast never takes focus. Its Dismiss button is reachable with Tab,
 *     and Escape on it dismisses that toast too;
 *   • time stands still while a toast is hovered or has focus, while the tab
 *     is hidden, and while a modal dialog is open;
 *   • the tone is in the text ("Success: …"), not only in colour or icon.
 *
 * Native dialogs: a modal <dialog> puts the rest of the page, this region
 * included, behind the top layer and makes it inert — unreadable and
 * unreachable. So while one is open, toasts are held, not shown: they wait,
 * with their time stopped, and appear (and are announced) when it closes.
 * An action started inside a dialog reports its own result inside it.
 *
 * Motion: each toast fades in with motion-appear (opacity only, 0ms with
 * reduced motion) and leaves at once. Nothing slides; nothing reflows under
 * an animation.
 */

export interface ToastOptions {
  /** A stable identity: showing the same id again restarts that toast instead of adding one. */
  id?: string;
}

export interface ToastApi {
  success: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast() must be used inside a ToastProvider.");
  return api;
}

/** How often the clock advances while it runs. */
const TICK_MS = 250;

const TONE_LABEL: Record<ToastTone, string> = { success: "Success", info: "Information" };

/** True while any modal <dialog> is open (showModal()). */
function useModalDialogOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => {
      let found: Element | null;
      try {
        found = document.querySelector("dialog:modal");
      } catch {
        found = document.querySelector("dialog[open]");
      }
      setOpen(found !== null);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, []);
  return open;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<ToastQueue>(EMPTY_QUEUE);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const modalOpen = useModalDialogOpen();
  const tabHidden = useDocumentHidden();
  const listRef = useRef<HTMLOListElement>(null);
  const nextId = useRef(0);

  // A toast removed from under the pointer or focus may send no pointerout
  // or blur: once none is left, neither can be holding the clock.
  if (queue.visible.length === 0 && (hovered || focused)) {
    setHovered(false);
    setFocused(false);
  }

  const shown = queue.visible.length > 0 && !modalOpen;
  const paused = modalOpen || tabHidden || (shown && (hovered || focused));

  // The clock: while it runs, each tick lets the time since the last one pass.
  useEffect(() => {
    if (paused || !shown) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const ms = now - last;
      last = now;
      setQueue((q) => elapse(q, ms));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [paused, shown]);

  const show = useCallback((tone: ToastTone, message: string, options?: ToastOptions) => {
    setQueue((q) => addToast(q, { tone, message, id: options?.id }, `toast-${++nextId.current}`));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, options) => show("success", message, options),
      info: (message, options) => show("info", message, options),
      dismiss: (id) => setQueue((q) => dismissToast(q, id)),
    }),
    [show]
  );

  // Dismissed by the user from inside the list: keep focus in the list — on
  // the next toast's Dismiss, or the list itself — rather than dropping it
  // on the document. Focus only ever moves here because the user acted.
  const dismissByUser = (id: string) => {
    const list = listRef.current;
    const hadFocus = list?.contains(document.activeElement) ?? false;
    const remaining = queue.visible.filter((t) => t.id !== id);
    setQueue((q) => dismissToast(q, id));
    if (hadFocus && list) {
      requestAnimationFrame(() => {
        const next = remaining[0] && list.querySelector<HTMLButtonElement>(`[data-toast-id="${CSS.escape(remaining[0].id)}"] button`);
        (next ?? list).focus();
      });
    }
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-toast) flex justify-center p-md sm:justify-end"
      >
        <ol
          ref={listRef}
          tabIndex={-1}
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions"
          className="flex w-full max-w-sm flex-col gap-sm outline-none"
          onPointerOver={() => setHovered(true)}
          onPointerOut={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
          }}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          {!modalOpen &&
            queue.visible.map((toast) => (
              <li
                key={toast.id}
                data-toast-id={toast.id}
                data-toast-tone={toast.tone}
                className="motion-appear pointer-events-auto flex items-start gap-sm rounded-panel border border-outline-variant bg-surface-container-lowest p-md text-body text-on-surface shadow-menu"
              >
                <ToneIcon tone={toast.tone} />
                <p className="min-w-0 flex-1">
                  <span className="sr-only">{TONE_LABEL[toast.tone]}: </span>
                  {toast.message}
                </p>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={() => dismissByUser(toast.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      dismissByUser(toast.id);
                    }
                  }}
                  className="motion-feedback -m-xs shrink-0 rounded-control p-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </li>
            ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

/** A distinct shape per tone: check for success, "i" for information. */
function ToneIcon({ tone }: { tone: ToastTone }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("mt-[2px] shrink-0", tone === "success" ? "text-success" : "text-info")}
    >
      <circle cx="12" cy="12" r="10" />
      {tone === "success" ? <path d="m9 12 2 2 4-4" /> : (
        <>
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </>
      )}
    </svg>
  );
}
