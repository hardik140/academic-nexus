"use client";

import { cn } from "@/lib/utils";
import { useEffect, useId } from "react";

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

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) {
      document.addEventListener("keydown", handleEsc);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-md">
      {/* Backdrop — a real button so the click-to-dismiss target is
          natively keyboard operable, instead of a div faking a click handler. */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[fade-in_0.15s_ease-out] cursor-default"
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "relative w-full bg-surface-container-lowest rounded-2xl shadow-xl border border-outline-variant animate-[slide-up_0.2s_ease-out]",
          sizeMap[size]
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-xl py-lg border-b border-outline-variant">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-on-surface">{title}</h2>
            {description && (
              <p className="text-sm text-on-surface-variant mt-xs">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-xs rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors"
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
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-xl py-md border-t border-outline-variant flex items-center justify-end gap-sm">
            {footer}
          </div>
        )}
      </div>
    </div>
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
        "inline-flex items-center justify-center gap-xs rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
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
        "inline-flex items-center gap-xs text-xs font-semibold px-sm py-xs rounded-full capitalize",
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
    "w-full bg-surface-container-low border border-border-control rounded-xl px-md py-sm text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all disabled:opacity-50";

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
