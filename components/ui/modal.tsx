"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: React.ReactNode;
}

const sizeMap = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
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
  const overlayRef = useRef<HTMLDivElement>(null);

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
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center p-md"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[fade-in_0.15s_ease-out]" />

      {/* Dialog */}
      <div
        className={cn(
          "relative w-full bg-surface-container-lowest rounded-2xl shadow-xl border border-outline-variant animate-[slide-up_0.2s_ease-out]",
          sizeMap[size]
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-xl py-lg border-b border-outline-variant">
          <div>
            <h2 className="text-lg font-bold text-on-surface">{title}</h2>
            {description && (
              <p className="text-sm text-on-surface-variant mt-xs">
                {description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-xs rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <svg
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

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
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

const statusColors: Record<string, string> = {
  present: "bg-success/10 text-success",
  active: "bg-success/10 text-success",
  approved: "bg-success/10 text-success",
  paid: "bg-success/10 text-success",
  cleared: "bg-success/10 text-success",
  completed: "bg-success/10 text-success",
  resolved: "bg-success/10 text-success",
  enrolled: "bg-success/10 text-success",
  placed: "bg-success/10 text-success",
  returned: "bg-success/10 text-success",

  pending: "bg-warning/10 text-warning",
  partial: "bg-warning/10 text-warning",
  late: "bg-warning/10 text-warning",
  in_progress: "bg-warning/10 text-warning",
  on_leave: "bg-warning/10 text-warning",

  absent: "bg-error/10 text-error",
  rejected: "bg-error/10 text-error",
  overdue: "bg-error/10 text-error",
  failed: "bg-error/10 text-error",
  suspended: "bg-error/10 text-error",
  dropped: "bg-error/10 text-error",
  expired: "bg-error/10 text-error",
  closed: "bg-error/10 text-error",
  escalated: "bg-error/10 text-error",

  excused: "bg-info/10 text-info",
  upcoming: "bg-info/10 text-info",
  ongoing: "bg-info/10 text-info",
  issued: "bg-info/10 text-info",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const color =
    statusColors[status] || "bg-surface-container-high text-on-surface-variant";
  return (
    <span
      className={cn(
        "inline-flex text-xs font-semibold px-sm py-xs rounded-full capitalize",
        color,
        className
      )}
    >
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
    "w-full bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all disabled:opacity-50";

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
