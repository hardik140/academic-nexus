/**
 * Money is INR with en-IN (lakh/crore) grouping and two decimals — owner
 * decision D2, the same output as the web app's lib/format.ts formatMoney:
 * 125000 → "₹1,25,000.00". There is no per-college currency.
 */
const moneyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(amount: number): string {
  return moneyFormatter.format(amount === 0 ? 0 : amount);
}

export function formatDate(date: string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(date));
}

export function formatPct(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}
