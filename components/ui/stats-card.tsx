"use client";

import { cn } from "@/lib/utils";

interface StatsCardProps {
  label: string;
  value: string | number;
  icon?: string;
  trend?: { value: number; direction: "up" | "down" };
  color?: "default" | "success" | "warning" | "error" | "info";
  progress?: { current: number; max: number };
  subtitle?: string;
  className?: string;
}

const colorMap = {
  default: "text-on-surface",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-info",
};

const progressColorMap = {
  default: "bg-secondary",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-info",
};

export function StatsCard({
  label,
  value,
  icon,
  trend,
  color = "default",
  progress,
  subtitle,
  className,
}: StatsCardProps) {
  return (
    <div
      className={cn(
        "bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm",
        className
      )}
    >
      <div className="flex items-center justify-between mb-sm">
        <span className="text-xs font-semibold text-outline uppercase tracking-wider">
          {label}
        </span>
        {icon && <span className="text-xl">{icon}</span>}
      </div>

      <div className={cn("text-3xl font-extrabold", colorMap[color])}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>

      {trend && (
        <div
          className={cn(
            "flex items-center gap-xs mt-sm text-xs font-semibold",
            trend.direction === "up" ? "text-success" : "text-error"
          )}
        >
          <span>{trend.direction === "up" ? "↑" : "↓"}</span>
          <span>{Math.abs(trend.value)}%</span>
          <span className="text-outline font-normal">vs last month</span>
        </div>
      )}

      {progress && (
        <>
          <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full",
                progressColorMap[color]
              )}
              style={{
                width: `${Math.min((progress.current / progress.max) * 100, 100)}%`,
              }}
            />
          </div>
          <div className="text-[11px] text-outline mt-xs">
            {progress.current} of {progress.max}
          </div>
        </>
      )}

      {subtitle && (
        <div className="text-[11px] text-outline mt-sm">{subtitle}</div>
      )}
    </div>
  );
}
