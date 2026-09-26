import { expect, test } from "@playwright/test";

// The development-only component gallery is reachable without a session under
// `next dev` and renders every section from static sample data.

const SECTIONS = ["colors", "typography", "buttons", "form-fields", "status-badges", "stats-cards", "data-table", "modal"];

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
