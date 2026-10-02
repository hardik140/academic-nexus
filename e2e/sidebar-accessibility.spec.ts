import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import navigation from "../tests/sidebar-navigation.fixture.json";

const items = navigation.director;
const widths = [375, 639, 640, 768, 1023, 1024, 1280];
const matrix: [string, string | null][] = [
  ["/director/placements", "Placements"],
  ["/director/placements/funnel", "Placements"],
  ["/director/departments/performance", "Departments"],
  ["/director/departments/performance/00000000-0000-4000-8000-000000000003", "Departments"],
  ["/director/placements-extra", null],
  ["/director/departments-other", null],
  ["/director/dashboard", "Dashboard"],
  ["/director", null],
  ["/", null],
];
async function openShell(page: Page) {
  await page.goto("/dev/shell");
  await page.getByRole("button", { name: "Background action", exact: true }).click();
  await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 1");
}
async function setPath(page: Page, path: string) {
  // Installed Next.js syncs native history with usePathname. Keep the real
  // shell mounted without requiring protected role accounts or altering hrefs.
  await page.evaluate((path) => window.history.pushState(null, "", path), path);
  const segments = path.split("/").filter(Boolean);
  const last = segments.pop();
  const breadcrumb = last && /^[0-9a-f-]{36}$/i.test(last) ? segments.pop() : last;
  await expect(page.locator("header")).toContainText(breadcrumb?.replace(/-/g, " ") ?? "dashboard");
}
async function panel(page: Page, state: "expanded" | "collapsed" | "drawer") {
  if (state === "drawer") {
    await page.getByRole("button", { name: "Open menu" }).click();
    const d = page.getByRole("dialog", { name: "Menu" });
    await expect(d).toBeVisible();
    return d;
  }
  if (state === "collapsed") await page.getByRole("button", { name: "Collapse sidebar" }).click();
  return page.locator("aside");
}
async function names(p: Locator) {
  await expect(p.getByRole("navigation").getByRole("link")).toHaveCount(items.length);
  for (const item of items) {
    const link = p.getByRole("link", { name: item.label, exact: true });
    await expect(link).toHaveAccessibleName(item.label);
    // Read the remaining contract together; retain the existing stabilization
    // window without spending a separate browser round trip on each attribute.
    await expect.poll(() => link.evaluate((a) => ({
      href: a.getAttribute("href"),
      iconAriaHidden: a.querySelector("span")?.getAttribute("aria-hidden"),
      tag: a.tagName,
      role: a.getAttribute("role"),
      label: a.getAttribute("aria-label"),
      tabindex: a.getAttribute("tabindex"),
    }))).toEqual({ href: item.href, iconAriaHidden: "true", tag: "A", role: null, label: null, tabindex: null });
  }
}
async function current(p: Locator, label: string | null) {
  await expect(p.locator('nav a[aria-current="page"]')).toHaveCount(label ? 1 : 0);
  if (label) {
    const link = p.getByRole("link", { name: label, exact: true });
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(link).toHaveClass(/bg-secondary/);
  }
  await expect(p.locator("nav[aria-current], span[aria-current]")).toHaveCount(0);
}
async function keyboardLinks(page: Page, p: Locator) {
  const links = items.map((item) => p.getByRole("link", { name: item.label, exact: true }));
  await links[0].focus();
  for (let i = 0; i < links.length; i++) {
    await expect(links[i]).toBeFocused();
    if (i < links.length - 1) await page.keyboard.press("Tab");
  }
  for (let i = links.length - 1; i >= 0; i--) {
    await expect(links[i]).toBeFocused();
    if (i > 0) await page.keyboard.press("Shift+Tab");
  }
  await expect(p.locator('nav [aria-hidden="true"][tabindex]')).toHaveCount(0);
}

for (const width of widths) {
  test(`sidebar accessibility at ${width}px: names, current section, keyboard and geometry`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openShell(page);
    await setPath(page, "/director/placements/funnel");
    const mobile = width < 1024;
    const p = await panel(page, mobile ? "drawer" : "expanded");
    await names(p);
    await current(p, "Placements");
    await keyboardLinks(page, p);
    expect(await p.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(256);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Hidden desktop duplicates never appear in the accessibility tree.
    await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toHaveCount(1);
    if (mobile) {
      await expect(page.locator("aside")).toBeHidden();
      expect(await p.evaluate((el) => el.matches(":modal"))).toBe(true);
      expect(await page.getByRole("button", { name: "Background action", includeHidden: true, exact: true }).evaluate((el: HTMLElement) => (el.focus(), document.activeElement === el))).toBe(false);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
      await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toHaveCount(0);
    } else {
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await names(p);
      await current(p, "Placements");
      await keyboardLinks(page, p);
      expect(await p.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(72);
      await expect(p.locator("nav span.sr-only")).toHaveCount(items.length);
      await expect(p.locator("nav span.truncate")).toHaveCount(0);
      await expect(page.locator("dialog")).toHaveCount(0);
      await page.screenshot({ path: `playwright/.cache/gate5/sidebar-collapsed-${width}-${test.info().project.name}.png` });
    }
  });
}
for (const state of ["expanded", "collapsed", "drawer"] as const) {
  test(`${state}: route boundaries and sole aria-current on the production sidebar`, async ({ page }) => {
    await page.setViewportSize({ width: state === "drawer" ? 375 : 1280, height: 800 });
    await openShell(page);
    if (state === "collapsed") await page.getByRole("button", { name: "Collapse sidebar" }).click();
    for (const [path, label] of matrix) {
      // Route changes close the drawer by design, so reopen it for each route.
      await setPath(page, path);
      const p = state === "drawer" ? await panel(page, "drawer") : page.locator("aside");
      await current(p, label);
      await names(p);
      if (state === "drawer") {
        await page.keyboard.press("Escape");
        await expect(page.locator("dialog")).toHaveCount(0);
      }
    }
  });
  test(`${state}: axe and decorative icon cannot supply a name when text is removed`, async ({ page }) => {
    await page.setViewportSize({ width: state === "drawer" ? 375 : 1280, height: 800 });
    await openShell(page);
    await setPath(page, "/director/placements/funnel");
    const p = await panel(page, state);
    await names(p);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations).toEqual([]);
    const link = p.locator('a[href="/director/placements/funnel"]');
    await link.locator("span").last().evaluate((el) => { el.textContent = ""; });
    await expect(link).toHaveAccessibleName("");
    await link.locator("span").last().evaluate((el) => { el.textContent = "Placements"; });
    await expect(link).toHaveAccessibleName("Placements");
  });
}
for (const state of ["collapsed", "drawer"] as const) {
  test(`${state}: Enter preserves the configured native link destination`, async ({ page }) => {
    await page.setViewportSize({ width: state === "drawer" ? 375 : 1280, height: 800 });
    await openShell(page);
    const p = await panel(page, state);
    const link = p.getByRole("link", { name: "Attention", exact: true });
    await link.focus();
    const requested = page.waitForRequest((r) => new URL(r.url()).pathname === "/director/attention");
    await page.keyboard.press("Enter");
    await requested;
    if (state === "drawer") await expect(page.locator("dialog[open]")).toHaveCount(0);
  });
}
