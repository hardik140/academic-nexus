"use client";

import { cn } from "@/lib/utils";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: React.ReactNode;
}

// Arbitrary values, not the named max-w-{sm,md,lg} classes: this project's
// @theme block in app/globals.css defines --spacing-{xs,sm,md,lg,xl,2xl,3xl}
// for the padding/gap scale (p-md, gap-sm, etc). Tailwind v4 resolves
// max-w-{name} from a same-named --spacing-{name} token when one exists,
// ahead of its own built-in --container-{name} — so max-w-sm/md/lg/2xl were
// silently collapsing to 8px/16px/24px/48px instead of real container
// widths. max-w-4xl was unaffected (no --spacing-4xl override exists), which
// is why this only showed up on modals using the default "md" size.
const sizeMap = {
  sm: "max-w-[24rem]",
  md: "max-w-[32rem]",
  lg: "max-w-[42rem]",
  xl: "max-w-4xl",
};

type ModalContent = Pick<ModalProps, "title" | "description" | "children" | "footer">;

/**
 * A native <dialog> opened with showModal(), so the browser supplies the
 * modal behaviour: the top layer and its ::backdrop, an inert page behind
 * it, focus moved inside on open and returned to the opener on close, and
 * Escape. `open` stays the single source of truth: Escape and a click on the
 * backdrop ask the caller through onClose, and the dialog follows the prop.
 *
 * On close it plays motion-dialog's exit showing its content as it last was
 * while open (callers usually clear the state behind that content in the
 * same update), inert so nothing in it can be used while it fades, and is
 * then unmounted, as before, so the content never keeps state between
 * openings. Nothing waits on the exit to decide whether the dialog is open.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  footer,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);

  // What the dialog shows: the live props while open, the last open ones
  // while it closes, and null (nothing rendered) once it has closed.
  const [shown, setShown] = useState<ModalContent | null>(
    open ? { title, description, children, footer } : null
  );
  if (
    open &&
    (shown === null ||
      shown.title !== title ||
      shown.description !== description ||
      shown.children !== children ||
      shown.footer !== footer)
  ) {
    setShown({ title, description, children, footer });
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
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={shown.description ? descriptionId : undefined}
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
      className={cn(
        "motion-dialog m-auto w-[calc(100%-2*var(--spacing-md))] max-h-[calc(100%-2*var(--spacing-md))] text-inherit bg-surface-container-lowest rounded-2xl shadow-xl border border-outline-variant backdrop:bg-black/50 backdrop:backdrop-blur-sm",
        sizeMap[size]
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-xl py-lg border-b border-outline-variant">
        <div>
          <h2 id={titleId} className="text-lg font-bold text-on-surface">{shown.title}</h2>
          {shown.description && (
            <p id={descriptionId} className="text-sm text-on-surface-variant mt-xs">
              {shown.description}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="p-xs rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface motion-feedback"
        >
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="px-xl py-lg max-h-[60vh] overflow-y-auto">
        {shown.children}
      </div>

      {/* Footer */}
      {shown.footer && (
        <div className="px-xl py-md border-t border-outline-variant flex items-center justify-end gap-sm">
          {shown.footer}
        </div>
      )}
    </dialog>
  );
}

// ─── Button Component ────────────────────────────────────────────

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
}

const buttonVariants = {
  primary:
    "bg-secondary text-on-secondary hover:bg-secondary-container shadow-md",
  secondary:
    "bg-surface-container-low text-on-surface hover:bg-surface-container-high border border-outline-variant",
  outline:
    "border border-outline-variant text-on-surface-variant hover:bg-surface-container-low",
  ghost: "text-on-surface-variant hover:bg-surface-container-low",
  destructive: "bg-error text-on-error hover:bg-error/90 shadow-md",
};

const buttonSizes = {
  sm: "px-sm py-xs text-xs",
  md: "px-md py-sm text-sm",
  lg: "px-lg py-md text-sm",
};

/**
 * Defaults to type="button". A native <button> defaults to "submit", so an
 * untyped Button placed inside a <form> would submit it — a Cancel button
 * included. Submit and reset buttons must say so explicitly.
 */
export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-xs rounded-xl font-semibold motion-feedback disabled:opacity-50 disabled:cursor-not-allowed",
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
      {...props}
    />
  );
}

// ─── StatusBadge ─────────────────────────────────────────────────

interface StatusBadgeProps {
  status: string;
  className?: string;
}

/**
 * Each status renders in one of five tones. A tone is a container /
 * on-container token pair from app/globals.css (at least 6.4:1), and the
 * word is always shown, so colour is never the only signal.
 *
 * Academic-period lifecycle: planned → info, active → success,
 * closed → neutral with a lock (read-only, not a failure), reopened → warning.
 */
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  success: "bg-success-container text-on-success-container",
  warning: "bg-warning-container text-on-warning-container",
  error: "bg-error-container text-on-error-container",
  info: "bg-info-container text-on-info-container",
  neutral: "bg-neutral-container text-on-neutral-container",
};

const statusTones: Record<string, StatusTone> = {
  present: "success",
  active: "success",
  approved: "success",
  paid: "success",
  cleared: "success",
  completed: "success",
  resolved: "success",
  enrolled: "success",
  placed: "success",
  returned: "success",
  on_track: "success",
  achieved: "success",
  low: "success",

  pending: "warning",
  partial: "warning",
  late: "warning",
  in_progress: "warning",
  on_leave: "warning",
  open: "warning",
  assigned: "warning",
  acknowledged: "warning",
  sent_back: "warning",
  info_requested: "warning",
  at_risk: "warning",
  medium: "warning",
  high: "warning",
  reopened: "warning",

  absent: "error",
  rejected: "error",
  overdue: "error",
  failed: "error",
  suspended: "error",
  dropped: "error",
  expired: "error",
  escalated: "error",
  off_track: "error",
  dismissed: "error",
  critical: "error",
  withdrawn: "error",

  excused: "info",
  upcoming: "info",
  ongoing: "info",
  issued: "info",
  delegated: "info",
  planned: "info",

  closed: "neutral",
  abandoned: "neutral",
};

/** The tone a status renders in; an unknown status is neutral. */
export function statusTone(status: string): StatusTone {
  return Object.prototype.hasOwnProperty.call(statusTones, status) ? statusTones[status] : "neutral";
}

/** Statuses meaning "read-only now": shown with a lock beside the word. */
const LOCKED_STATUSES = new Set(["closed"]);

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-xs text-xs font-semibold px-sm py-xs rounded-full capitalize motion-state",
        toneClasses[statusTone(status)],
        className
      )}
    >
      {LOCKED_STATUSES.has(status) && (
        <svg
          aria-hidden="true"
          data-icon="lock"
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      )}
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ─── FormField ───────────────────────────────────────────────────

interface FormFieldProps {
  label: string;
  id: string;
  type?: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  options?: { value: string; label: string }[];
  rows?: number;
  disabled?: boolean;
}

export function FormField({
  label,
  id,
  type = "text",
  value,
  onChange,
  placeholder,
  required,
  error,
  options,
  rows,
  disabled,
}: FormFieldProps) {
  const baseClasses =
    "w-full bg-surface-container-low border border-border-control rounded-xl px-md py-sm text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none motion-feedback disabled:opacity-50";

  return (
    <div className="space-y-xs">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-on-surface-variant"
      >
        {label}
        {required && <span className="text-error ml-xs">*</span>}
      </label>

      {type === "select" && options ? (
        <select
          id={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          disabled={disabled}
          className={baseClasses}
        >
          <option value="">Select {label}...</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          id={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          rows={rows || 3}
          disabled={disabled}
          className={cn(baseClasses, "resize-none")}
        />
      ) : (
        <input
          id={id}
          type={type}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className={baseClasses}
        />
      )}

      {error && (
        <p className="text-xs text-error font-medium">{error}</p>
      )}
    </div>
  );
}
