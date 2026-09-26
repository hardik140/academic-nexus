import { expect, test } from "@playwright/test";

// Unauthenticated routing, verified in a real browser. The test server has no
// reachable Supabase (see playwright.config.ts), so these requests carry no
// session and exercise only the middleware's redirect behaviour.

const PROTECTED_PATHS = ["/", "/student/dashboard", "/teacher/attendance", "/finance/refunds", "/security/scanner"];

for (const path of PROTECTED_PATHS) {
  test(`unauthenticated ${path} redirects to /login`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  });
}

test("login page renders a labelled sign-in form without runtime errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/login");

  await expect(page.getByRole("heading", { level: 1, name: "Academic Nexus" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to your portal" })).toBeVisible();
  await expect(page.getByLabel("Institutional Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("login page has no horizontal overflow", async ({ page }) => {
  await page.goto("/login");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
