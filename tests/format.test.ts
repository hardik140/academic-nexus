import { describe, expect, it } from "vitest";
import { APP_TIME_ZONE, formatDate, formatMoney, MISSING_VALUE, todayInTimeZone } from "@/lib/format";

describe("formatMoney: INR, en-IN grouping, two decimals", () => {
  it.each([
    [0, "₹0.00"],
    [7, "₹7.00"],
    [1250.5, "₹1,250.50"],
    [125000, "₹1,25,000.00"],
    [12500000, "₹1,25,00,000.00"],
    [99.999, "₹100.00"],
    [-250.5, "-₹250.50"],
  ])("%s → %s", (input, expected) => {
    expect(formatMoney(input)).toBe(expected);
  });

  it("accepts numeric strings, as Supabase returns numeric columns", () => {
    expect(formatMoney("48000.00")).toBe("₹48,000.00");
    expect(formatMoney(" 1500 ")).toBe("₹1,500.00");
  });

  it("never renders a negative zero", () => {
    expect(formatMoney(-0)).toBe("₹0.00");
  });

  it.each([null, undefined, NaN, Infinity, -Infinity, "", "   ", "abc"])(
    "%s → the missing-value marker, not ₹NaN or a misleading ₹0.00",
    (input) => {
      expect(formatMoney(input as number | string | null | undefined)).toBe(MISSING_VALUE);
    }
  );

  it("has no USD fallback anywhere in its output", () => {
    for (const amount of [0, 1, 1234.5, 125000]) expect(formatMoney(amount)).not.toMatch(/\$|USD/);
  });
});

describe("formatDate", () => {
  it("formats a date-only string as that exact calendar day, with no time-zone shift", () => {
    expect(formatDate("2026-09-27")).toBe(new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 8, 27))));
    expect(formatDate("2026-09-27")).toMatch(/27/);
    expect(formatDate("2026-01-01")).toMatch(/2026/);
  });

  it("shows an instant in Asia/Kolkata time", () => {
    // 2026-09-26T20:00Z is 27 Sep 01:30 in India — the IST day, not the UTC day.
    const instant = "2026-09-26T20:00:00Z";
    expect(formatDate(instant)).toMatch(/27/);
    expect(formatDate(instant, "time")).toMatch(/1:30/);
    expect(formatDate(instant, "datetime")).toMatch(/27/);
  });

  it.each([null, undefined, "", "not a date", "2026-13-45"])("%s → the missing-value marker", (input) => {
    expect(formatDate(input as string | null | undefined)).toBe(MISSING_VALUE);
  });
});

describe("todayInTimeZone", () => {
  it("defaults to Asia/Kolkata", () => {
    expect(APP_TIME_ZONE).toBe("Asia/Kolkata");
  });

  it("is the IST calendar day during the 00:00–05:29 IST window where UTC is still the previous day", () => {
    // 2026-09-26T19:00Z = 2026-09-27 00:30 IST — the window D7 found.
    const now = new Date("2026-09-26T19:00:00Z");
    expect(now.toISOString().split("T")[0]).toBe("2026-09-26");
    expect(todayInTimeZone(undefined, now)).toBe("2026-09-27");
  });

  it("agrees with UTC once both are on the same day", () => {
    expect(todayInTimeZone(undefined, new Date("2026-09-27T10:00:00Z"))).toBe("2026-09-27");
  });

  it("rolls over at IST midnight, not UTC midnight", () => {
    expect(todayInTimeZone(undefined, new Date("2026-09-27T18:29:59Z"))).toBe("2026-09-27");
    expect(todayInTimeZone(undefined, new Date("2026-09-27T18:30:00Z"))).toBe("2026-09-28");
  });

  it("returns zero-padded YYYY-MM-DD and honours another zone when asked", () => {
    expect(todayInTimeZone("UTC", new Date("2026-01-05T03:00:00Z"))).toBe("2026-01-05");
    expect(todayInTimeZone("America/New_York", new Date("2026-01-05T03:00:00Z"))).toBe("2026-01-04");
  });
});
