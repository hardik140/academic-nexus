import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function tableDemo(page: Page) {
  await page.goto("/dev/gallery");
  await expect(page.getByTestId("resource-status")).toHaveText("success");
  const section = page.getByTestId("gallery-data-table");
  const table = section.locator("table").first();
  return { section, table, region: table.locator(".."), search: section.getByPlaceholder("Search by name...") };
}

async function visibleFocus(control: Locator) {
  await expect(control).toBeFocused();
  const focus = await control.evaluate((el) => {
    const style = getComputedStyle(el);
    return { visible: el.matches(":focus-visible"), width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
  });
  expect(focus.visible).toBe(true);
  expect(focus.width).toBe("2px");
  expect(focus.style).toBe("solid");
  expect(focus.color).toBe("rgb(0, 81, 213)");
}

for (const activation of ["mouse", "Enter", "Space"] as const) {
  test(`DataTable sorts once per ${activation} activation, preserves toggle and column switching`, async ({ page }) => {
    const { table, search, region } = await tableDemo(page);
    const student = table.getByRole("button", { name: "Sort by Student", exact: true });
    const header = student.locator("..");
    await expect(header).toHaveAttribute("aria-sort", "none");
    await search.focus();
    await page.keyboard.press("Tab");
    if (await region.getAttribute("tabindex") === "0") await page.keyboard.press("Tab");
    await expect(table.getByRole("button", { name: "Sort by Enrollment" })).toBeFocused();
    await page.keyboard.press("Tab");
    await visibleFocus(student);
    const activate = () => activation === "mouse" ? header.click({ position: { x: 2, y: 2 } }) : student.press(activation);
    for (const [direction, first] of [["ascending", "Arjun Menon"], ["descending", "Vikram Nair"], ["ascending", "Arjun Menon"]]) {
      await activate();
      await expect(header).toHaveAttribute("aria-sort", direction);
      await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveText(first);
      await expect(table.locator('th[aria-sort="ascending"], th[aria-sort="descending"]')).toHaveCount(1);
    }
    await expect(student).toHaveAccessibleName("Sort by Student");
    await expect(student.locator('[aria-hidden="true"]')).toHaveText("↑");
    await table.getByRole("button", { name: "Sort by Amount" }).press("Enter");
    await expect(header).toHaveAttribute("aria-sort", "none");
    await expect(table.getByRole("columnheader", { name: "Sort by Amount" })).toHaveAttribute("aria-sort", "ascending");
    await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveText("Meera Iyer");
    const programme = table.getByRole("columnheader", { name: "Programme", exact: true });
    await expect(programme.locator("button")).toHaveCount(0);
    expect(await programme.getAttribute("aria-sort")).toBeNull();
    await programme.click();
    await expect(table.getByRole("columnheader", { name: "Sort by Amount" })).toHaveAttribute("aria-sort", "ascending");
  });
}

for (const width of [375, 639, 640, 768, 1023, 1024, 1280]) {
  test(`DataTable scroll region and keyboard focus at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { table, region, search } = await tableDemo(page);
    const sizes = await region.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    const overflow = sizes.scroll > sizes.client;
    if (width === 375) expect(overflow).toBe(true);
    await expect(region).toHaveAttribute("tabindex", overflow ? "0" : "-1");
    await search.focus();
    await page.keyboard.press("Tab");
    if (overflow) {
      await expect(region).toHaveAttribute("role", "region");
      await expect(region).toHaveAccessibleName(/scrollable table/);
      await visibleFocus(region);
      await expect(region).toHaveCSS("outline-offset", "-2px");
      await region.press("ArrowRight");
      await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      await page.keyboard.press("Tab");
    }
    const first = table.getByRole("button", { name: "Sort by Enrollment" });
    await visibleFocus(first);
    await expect(region.locator('div[tabindex="0"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 375 || width === 1280) {
      await testInfo.attach("table-focus.png", { body: await region.screenshot(), contentType: "image/png" });
    }
    await testInfo.attach("scroll-audit.json", { body: JSON.stringify({ width, ...sizes, overflow, tabIndex: await region.getAttribute("tabindex") }), contentType: "application/json" });
  });
}

test("DataTable removes the wrapper tab stop after resize and restores it when narrow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const { region } = await tableDemo(page);
  await expect(region).toHaveAttribute("tabindex", "0");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(region).toHaveAttribute("tabindex", "-1");
  expect(await region.getAttribute("role")).toBeNull();
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(region).toHaveAttribute("tabindex", "0");
});

test("DataTable server-mode loading keeps keyboard sort semantics", async ({ page }) => {
  const { section } = await tableDemo(page);
  const table = section.locator("table").nth(2);
  const button = table.getByRole("button", { name: "Sort by Enrollment" });
  await button.press("Enter");
  await expect(button.locator("..")).toHaveAttribute("aria-sort", "ascending");
  await button.press("Space");
  await expect(button.locator("..")).toHaveAttribute("aria-sort", "descending");
  await expect(table.locator("tbody")).toHaveText("Loading…");
});

test("DataTables pass axe including the former mobile scroll-region debt", async ({ page }) => {
  await tableDemo(page);
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="gallery-data-table"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations).toEqual([]);
});
