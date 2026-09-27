import { expect, test } from "@playwright/test";

// The development-only component gallery is reachable without a session under
// `next dev` and renders every section from static sample data.

const SECTIONS = [
  "colors",
  "typography",
  "lifecycle",
  "surfaces",
  "charts",
  "motion",
  "motion-utilities",
  "funnel-chart",
  "buttons",
  "form-fields",
  "status-badges",
  "stats-cards",
  "data-table",
  "modal",
  "button-form",
  "async-resource",
];

test("gallery renders every section without runtime errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/dev/gallery");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/dev\/gallery$/);
  await expect(page.getByRole("heading", { level: 1, name: "Component gallery" })).toBeVisible();

  for (const id of SECTIONS) {
    await expect(page.getByTestId(`gallery-${id}`)).toBeVisible();
  }

  expect(pageErrors).toEqual([]);
});

test("gallery modal opens as a labelled dialog and closes on Escape", async ({ page }) => {
  await page.goto("/dev/gallery");
  await page.getByRole("button", { name: "Open modal" }).click();

  const dialog = page.getByRole("dialog", { name: "Sample modal" });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("an untyped Button inside a form does not submit it; an explicit submit does", async ({ page }) => {
  await page.goto("/dev/gallery");
  const form = page.getByRole("form", { name: "Button form behaviour" });
  const count = page.getByTestId("submit-count");

  await expect(form.getByRole("button", { name: "Untyped button" })).toHaveAttribute("type", "button");
  await form.getByRole("button", { name: "Untyped button" }).click();
  await expect(count).toHaveText("Submissions: 0");

  await expect(form.getByRole("button", { name: "Explicit submit" })).toHaveAttribute("type", "submit");
  await form.getByRole("button", { name: "Explicit submit" }).click();
  await expect(count).toHaveText("Submissions: 1");
});

test("useAsyncResource: loading → success, loading → error, reload, and stale results discarded", async ({ page }) => {
  await page.goto("/dev/gallery");
  const status = page.getByTestId("resource-status");
  const data = page.getByTestId("resource-data");
  const section = page.getByTestId("gallery-async-resource");

  // Initial load.
  await expect(status).toHaveText("success");
  await expect(data).toHaveText("initial");

  // A failure is an error — never success with empty data.
  await section.getByRole("button", { name: "Load (fails)" }).click();
  await expect(status).toHaveText("loading");
  await expect(data).toHaveText("none"); // new request: the previous record's data is not carried over
  await expect(status).toHaveText("error");
  await expect(section).toContainText("Error: Sample failure");

  // Success after a failure.
  await section.getByRole("button", { name: "Load (succeeds)" }).click();
  await expect(status).toHaveText("success");
  await expect(data).toHaveText("loaded");

  // Reload keeps the last good data visible while loading.
  await section.getByRole("button", { name: "Reload" }).click();
  await expect(status).toHaveText("loading");
  await expect(data).toHaveText("loaded");
  await expect(status).toHaveText("success");

  // A slow request overtaken by a fast one: the slow result must never land.
  await section.getByRole("button", { name: "Slow then fast" }).click();
  await expect(data).toHaveText("fast");
  await page.waitForTimeout(1500); // past the slow request's 1200 ms
  await expect(status).toHaveText("success");
  await expect(data).toHaveText("fast");
});
