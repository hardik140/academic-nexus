/**
 * Centralised display formatting (owner decisions D2 and D7).
 *
 * Every college is in India: money is INR with en-IN (lakh/crore) grouping,
 * and "today" is the Asia/Kolkata calendar day. There is no per-college
 * currency or time zone — the colleges table has no such columns, and adding
 * them is out of scope.
 *
 * This module is the foundation only. lib/utils.ts's formatCurrency (USD,
 * en-US) and formatDate (en-US) are still used by existing screens and are
 * deliberately left unchanged here; screens move to these functions as they
 * are redesigned, so that no screen changes appearance before its own stage.
 * Likewise the UTC "today" calculations that D7 identified are fixed in their
 * own track, not by this file's existence.
 */

export const APP_LOCALE = "en-IN";
export const APP_CURRENCY = "INR";
export const APP_TIME_ZONE = "Asia/Kolkata";

/** Shown when a value is missing or not a finite number/date. */
export const MISSING_VALUE = "—";

const moneyFormatter = new Intl.NumberFormat(APP_LOCALE, {
  style: "currency",
  currency: APP_CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats an amount of rupees as INR with en-IN grouping and exactly two
 * decimals: 125000 → "₹1,25,000.00", -250.5 → "-₹250.50".
 *
 * Accepts numeric strings because Supabase returns `numeric` columns as
 * strings. Anything that is not a finite number returns MISSING_VALUE rather
 * than "₹NaN" or a misleading "₹0.00".
 */
export function formatMoney(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return MISSING_VALUE;
  const value = typeof amount === "string" ? (amount.trim() === "" ? NaN : Number(amount)) : amount;
  if (!Number.isFinite(value)) return MISSING_VALUE;
  // Normalise -0 so a zero balance never renders as "-₹0.00".
  return moneyFormatter.format(value === 0 ? 0 : value);
}

export type DateFormat = "date" | "datetime" | "time";

const DATE_OPTIONS: Record<DateFormat, Intl.DateTimeFormatOptions> = {
  date: { day: "numeric", month: "short", year: "numeric" },
  datetime: { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" },
  time: { hour: "numeric", minute: "2-digit" },
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Formats a date for display in en-IN.
 *
 * - A date-only string ("2026-09-27", as Postgres DATE columns arrive) is a
 *   calendar day, not an instant: it is formatted as that exact day, never
 *   shifted by a time zone. Only the "date" format is meaningful for it.
 * - Any other value is an instant and is shown in Asia/Kolkata time.
 *
 * Invalid input returns MISSING_VALUE.
 */
export function formatDate(
  value: string | number | Date | null | undefined,
  format: DateFormat = "date"
): string {
  if (value === null || value === undefined || value === "") return MISSING_VALUE;

  if (typeof value === "string" && DATE_ONLY.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) return MISSING_VALUE;
    return new Intl.DateTimeFormat(APP_LOCALE, { ...DATE_OPTIONS.date, timeZone: "UTC" }).format(day);
  }

  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return MISSING_VALUE;
  return new Intl.DateTimeFormat(APP_LOCALE, { ...DATE_OPTIONS[format], timeZone: APP_TIME_ZONE }).format(instant);
}

/**
 * The calendar date ("YYYY-MM-DD") that it currently is in `timeZone` —
 * Asia/Kolkata by default. Use this instead of
 * `new Date().toISOString().split("T")[0]`, which gives the UTC date and is
 * yesterday in India until 05:30.
 *
 * `now` is injectable so callers and tests can pin the instant.
 */
export function todayInTimeZone(timeZone: string = APP_TIME_ZONE, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
