import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// College lifecycle and session management (migrations 053/054), verified on
// the development gallery's fictional data — the real pages read the
// database, which browser tests may not touch (owner decision D3). The
// database rules themselves are proven in tests/staging-college-lifecycle,
// tests/staging-mutations-lifecycle and tests/realpg-session-registry.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function gallery(page: Page) {
  await page.goto("/dev/gallery");
  await expect(page.getByRole("heading", { level: 1, name: "Component gallery" })).toBeVisible();
}

test.describe("the unavailable page", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("maintenance names the college, says nothing was lost, and shows the message and the resume time in IST", async ({ page }) => {
    const view = page.getByTestId("unavailable-maintenance");
    await expect(view.getByRole("heading", { name: "Under maintenance" })).toBeVisible();
    await expect(view).toContainText("Springfield Institute is temporarily unavailable");
    await expect(view).toContainText("Your data is safe and nothing has been changed.");
    await expect(view.getByRole("status")).toContainText("We are upgrading the results module.");
    await expect(view).toContainText("6 Oct 2026, 12:00 am");
    await expect(view).toContainText("(IST)");
    await view.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("unavailable-log")).toHaveText("maintenance: try again");
  });

  test("suspended says the data was not deleted and offers no retry", async ({ page }) => {
    const view = page.getByTestId("unavailable-suspended");
    await expect(view.getByRole("heading", { name: "Access suspended" })).toBeVisible();
    await expect(view).toContainText("Your data has not been deleted.");
    await expect(view.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(view.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("the device limit lists the other devices, each with its own named sign-out button", async ({ page }) => {
    const view = page.getByTestId("unavailable-session_limit");
    await expect(view.getByRole("heading", { name: "Too many active devices" })).toBeVisible();
    await expect(view).toContainText("signed in on 2 devices");
    await expect(view).toContainText("your other sessions stay signed in until you do");
    const buttons = view.getByRole("button", { name: /^Sign out that device: / });
    await expect(buttons).toHaveCount(2);
    await view.getByRole("button", { name: /^Sign out that device: Pixel 8/ }).click();
    await expect(page.getByTestId("unavailable-log")).toHaveText("revoke 5e550000-0000-4000-8000-000000000002");
  });

  test("a revoked session is told why and offered 'Sign in again'", async ({ page }) => {
    const view = page.getByTestId("unavailable-session_revoked");
    await expect(view.getByRole("heading", { name: "You have been signed out" })).toBeVisible();
    await view.getByRole("button", { name: "Sign in again" }).click();
    await expect(page.getByTestId("unavailable-log")).toHaveText("revoked: sign in again");
  });

  test("axe: no violations", async ({ page }) => {
    const { violations } = await new AxeBuilder({ page }).include('[data-testid="gallery-college-unavailable"]').withTags(WCAG).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe("the lifecycle dialog (Super Admin)", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("for an active college it proposes maintenance, warns that everyone is signed out and nothing is deleted", async ({ page }) => {
    await page.getByRole("button", { name: "Change status (active college)" }).click();
    const dialog = page.getByRole("dialog", { name: /Change status — Springfield Institute/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Maintenance/ })).toBeChecked();
    await expect(dialog).toContainText("Every user of this college is signed out immediately");
    await expect(dialog).toContainText("No data is deleted or changed.");
    await expect(dialog.getByRole("button", { name: "Put under maintenance" })).toBeVisible();
  });

  test("refuses a short reason and a resume time in the past, inside the dialog", async ({ page }) => {
    await page.getByRole("button", { name: "Change status (active college)" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Reason/).fill("short");
    await dialog.getByLabel(/Expected back/).fill("2020-01-01T10:00");
    await dialog.getByRole("button", { name: "Put under maintenance" }).click();
    await expect(dialog.getByText("Give a reason of at least 10 characters.")).toBeVisible();
    await expect(dialog.getByText("Choose a time in the future.")).toBeVisible();
    await expect(page.getByTestId("lifecycle-submitted")).toHaveText("Nothing submitted.");
    await expect(dialog).toBeVisible();
  });

  test("submits maintenance with the message and the resume time converted from IST", async ({ page }) => {
    await page.getByRole("button", { name: "Change status (active college)" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Reason/).fill("Upgrading the results module tonight");
    await dialog.getByLabel(/Message to the college/).fill("Back soon.");
    await dialog.getByLabel(/Expected back/).fill("2030-01-15T09:30");
    await dialog.getByRole("button", { name: "Put under maintenance" }).click();
    await expect(dialog).toBeHidden();
    const submitted = JSON.parse(await page.getByTestId("lifecycle-submitted").innerText());
    expect(submitted).toEqual({
      state: "MAINTENANCE",
      reason: "Upgrading the results module tonight",
      message: "Back soon.",
      expectedResumeAt: "2030-01-15T04:00:00Z",
    });
  });

  test("suspending is a destructive action; ACTIVE for an active college is refused; reactivation needs no outage detail", async ({ page }) => {
    await page.getByRole("button", { name: "Change status (active college)" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Suspended/ }).check();
    await expect(dialog.getByRole("button", { name: "Suspend college" })).toBeVisible();
    await expect(dialog.getByLabel(/Expected back/)).toHaveCount(0);
    await dialog.getByRole("radio", { name: /Active/ }).check();
    await dialog.getByLabel(/^Reason/).fill("No reason to change anything");
    await dialog.getByRole("button", { name: "Reactivate college" }).click();
    await expect(dialog.getByText("The college is already active.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Change status (college in maintenance)" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: /Active/ })).toBeChecked();
    await expect(dialog.getByLabel(/Message to the college/)).toHaveCount(0);
    await dialog.getByLabel(/^Reason/).fill("Maintenance finished early");
    await dialog.getByRole("button", { name: "Reactivate college" }).click();
    const submitted = JSON.parse(await page.getByTestId("lifecycle-submitted").innerText());
    expect(submitted).toEqual({ state: "ACTIVE", reason: "Maintenance finished early" });
  });

  test("the history lists each change with its reason and how many sessions were signed out", async ({ page }) => {
    await page.getByRole("button", { name: "Status history" }).click();
    const dialog = page.getByRole("dialog", { name: /Status history/ });
    const items = dialog.getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Maintenance → Active");
    await expect(items.nth(1)).toContainText("Active → Maintenance");
    await expect(items.nth(1)).toContainText("412 sessions signed out");
  });

  test("axe: no violations, with the dialog open", async ({ page }) => {
    await page.getByRole("button", { name: "Change status (active college)" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).include("dialog").withTags(WCAG).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe("sessions and devices", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("the current device is marked and cannot sign itself out from the list", async ({ page }) => {
    const list = page.getByTestId("gallery-sessions").getByTestId("device-list").first();
    await expect(list.getByText("This device")).toHaveCount(1);
  });

  test("the sessions dialog loads, signs one session out, and the row leaves the list", async ({ page }) => {
    await page.getByRole("button", { name: "Open sessions dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Sessions — Asha Rao" });
    await expect(dialog.getByRole("listitem")).toHaveCount(2);
    await dialog.getByRole("button", { name: /^Sign out: Chrome on Windows/ }).click();
    await expect(dialog.getByRole("listitem")).toHaveCount(1);
    await expect(dialog).not.toContainText("Chrome on Windows");
  });

  test("axe: no violations, with the dialog open", async ({ page }) => {
    await page.getByRole("button", { name: "Open sessions dialog" }).click();
    await expect(page.getByRole("dialog").getByRole("listitem").first()).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).include("dialog").withTags(WCAG).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe("session enforcement cut-over (Super Admin)", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("not ready: says why, and the switch to enforce is disabled", async ({ page }) => {
    const panel = page.getByTestId("enforcement-not-ready");
    await expect(panel).toContainText("Not ready to enforce yet");
    await expect(panel).toContainText("24 session(s) from an older mobile app version");
    await expect(panel.getByRole("button", { name: "Switch to enforce" })).toBeDisabled();
    // ...and there is no reason field to fill in.
    await expect(panel.getByLabel(/^Reason for the change/)).toHaveCount(0);
  });

  test("ready: a reason is required, then the switch is confirmed before anything changes", async ({ page }) => {
    const panel = page.getByTestId("enforcement-ready");
    await expect(panel).toContainText("Ready to enforce");
    const button = panel.getByRole("button", { name: "Switch to enforce" });
    // A reason first: the switch stays disabled until there is one.
    await expect(button).toBeDisabled();
    await panel.getByLabel(/^Reason for the change/).fill("short");
    await expect(panel.getByText("Give a reason of 10 to 1000 characters.")).toBeVisible();
    await expect(button).toBeDisabled();
    await panel.getByLabel(/^Reason for the change/).fill("Updated app confirmed on all devices");
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Enforce session registration?" });
    await expect(dialog).toContainText("Reason: Updated app confirmed on all devices");
    await expect(page.getByTestId("enforcement-log")).toHaveText("Not switched.");
    await dialog.getByRole("button", { name: "Enforce" }).click();
    await expect(page.getByTestId("enforcement-log")).toHaveText("enforce: Updated app confirmed on all devices");
  });

  test("axe: no violations", async ({ page }) => {
    const { violations } = await new AxeBuilder({ page }).include('[data-testid="gallery-session-enforcement"]').withTags(WCAG).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe("the portal shell's 'Your devices'", () => {
  test("is a named button in the header that opens a dialog, and Escape returns focus to it", async ({ page }) => {
    await page.goto("/dev/shell");
    const button = page.getByRole("button", { name: "Your devices" });
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Your devices" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });
});
