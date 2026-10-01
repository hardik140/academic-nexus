import { formatCurrency } from "../format";

// Owner decision D2: money is INR with en-IN grouping, never USD — the same
// output as the web app's lib/format.ts formatMoney.
describe("formatCurrency", () => {
  it.each([
    [1234.56, "₹1,234.56"],
    [125000, "₹1,25,000.00"],
    [12345678.9, "₹1,23,45,678.90"],
    [0, "₹0.00"],
    [-0, "₹0.00"],
  ])("%s → %s", (amount, expected) => {
    expect(formatCurrency(amount)).toBe(expected);
  });

  it("never renders dollars", () => {
    for (const amount of [0, 1, 1234.5, 125000]) expect(formatCurrency(amount)).not.toMatch(/\$|USD/);
  });
});
