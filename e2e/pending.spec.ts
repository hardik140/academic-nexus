import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// M6: the portal shell's navigation-pending marker and its toasts, on the
// development-only shell harness (app/dev/shell), which renders the real
// PortalShell for a fictional director.
//
// A navigation is made slow by holding every request for a portal page here:
// the isolated test server has no session, so the page could never load
// anyway, and the request is never answered. A navigation "arrives" when the
// pathname changes under the mounted shell — history.pushState, which Next.js
// syncs into usePathname, exactly as a completed client navigation does.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const DELAY_MS = 150; // PENDING_MARKER_DELAY_MS in components/portal/portal-shell.tsx

// Every test fails on a console error or warning, hydration mismatches included.
const consoleMessages = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  consoleMessages.set(page, messages);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") messages.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => messages.push(`[pageerror] ${e.message}`));
  // Portal pages never answer: every navigation to one stays pending.
  await page.route("**/director/**", () => {});
});
test.afterEach(({ page }) => {
  expect(consoleMessages.get(page), "console errors or warnings").toEqual([]);
});

async function openShell(page: Page) {
  await page.goto("/dev/shell");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Hydrated: a client click handler responds (a click before hydration is lost, so retry until one lands).
  const log = page.getByTestId("shell-log");
  await expect(async () => {
    if ((await log.textContent()) === "Background clicks: 0") await page.getByRole("button", { name: "Background action" }).click();
    await expect(log).toHaveText("Background clicks: 1", { timeout: 500 });
  }).toPass();
}

const marker = (page: Page) => page.getByTestId("nav-pending");
const main = (page: Page) => page.locator("main");
const menuButton = (page: Page) => page.getByRole("button", { name: "Open menu" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Menu" });

/** The marker is shown when it is not `invisible` (its space is always kept). */
async function markerShown(page: Page) {
  return marker(page).evaluate((el) => getComputedStyle(el).visibility === "visible");
}

/**
 * Clicks `link` and watches, from inside the page, when the marker first
 * shows and what aria-busy says. `arriveAfterMs` completes the navigation
 * that long after the click.
 */
async function clickAndWatch(link: Locator, { arriveAfterMs, watchMs }: { arriveAfterMs?: number; watchMs: number }) {
  return link.evaluate(
    (el: HTMLAnchorElement, { arriveAfterMs, watchMs }) =>
      new Promise<{ busySoonAfterClick: string | null; shownAfterMs: number | null; busyAtEnd: string | null; shownAtEnd: boolean }>((resolve) => {
        const m = document.querySelector<HTMLElement>('[data-testid="nav-pending"]')!;
        const mainEl = document.querySelector("main")!;
        // The class the shell toggles (computed visibility can lag it by a
        // 0.01ms transition under the global reduced-motion rule).
        const visible = () => !m.classList.contains("invisible");
        let shownAfterMs: number | null = null;
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (shownAfterMs === null && visible()) shownAfterMs = performance.now() - start;
        });
        observer.observe(m, { attributes: true, attributeFilter: ["class"] });
        el.click();
        let busySoonAfterClick: string | null = null;
        setTimeout(() => (busySoonAfterClick = mainEl.getAttribute("aria-busy")), 20);
        if (arriveAfterMs !== undefined) setTimeout(() => history.pushState(null, "", el.getAttribute("href")), arriveAfterMs);
        setTimeout(() => {
          observer.disconnect();
          resolve({ busySoonAfterClick, shownAfterMs, busyAtEnd: mainEl.getAttribute("aria-busy"), shownAtEnd: visible() });
        }, watchMs);
      }),
    { arriveAfterMs, watchMs }
  );
}

test.describe("navigation pending marker (1280px)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("a fast navigation never shows the marker; main is busy only until it arrives", async ({ page }) => {
    await openShell(page);
    await expect(marker(page)).toBeAttached();
    expect(await markerShown(page)).toBe(false);
    await expect(main(page)).not.toHaveAttribute("aria-busy");

    const run = await clickAndWatch(page.locator("aside").getByRole("link", { name: /Attention/ }), { arriveAfterMs: 60, watchMs: 500 });
    expect(run.busySoonAfterClick).toBe("true");
    expect(run.shownAfterMs).toBeNull();
    expect(run.shownAtEnd).toBe(false);
    expect(run.busyAtEnd).toBeNull();
  });

  test("a slow navigation shows the marker after 150ms — not before — and it has no motion; axe passes", async ({ page }) => {
    await openShell(page);
    const run = await clickAndWatch(page.locator("aside").getByRole("link", { name: /Decisions/ }), { watchMs: 600 });
    expect(run.busySoonAfterClick).toBe("true");
    expect(run.shownAfterMs).not.toBeNull();
    expect(run.shownAfterMs!).toBeGreaterThanOrEqual(DELAY_MS - 5);
    expect(run.shownAfterMs!).toBeLessThan(DELAY_MS + 400);
    expect(run.shownAtEnd).toBe(true);
    await expect(marker(page)).toHaveText("Loading page…");
    await expect(main(page)).toHaveAttribute("aria-busy", "true");

    // Static: no transition and no animation; not a live region (the busy
    // state is on <main>, and a passive loading message is never announced).
    const style = await marker(page).evaluate((el) => ({
      animations: el.getAnimations({ subtree: true }).length,
      durations: getComputedStyle(el).transitionDuration.split(",").map((d) => parseFloat(d)),
      live: el.closest("[aria-live],[role=status],[role=alert]") !== null,
    }));
    expect(style.animations).toBe(0);
    expect(style.durations.every((d) => d === 0)).toBe(true);
    expect(style.live).toBe(false);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  test("the route change ends it: marker hidden, main no longer busy, the page usable", async ({ page }) => {
    await openShell(page);
    await page.locator("aside").getByRole("link", { name: /Analytics/ }).click();
    await expect.poll(() => markerShown(page)).toBe(true);
    await page.evaluate(() => history.pushState(null, "", "/director/analytics"));
    await expect.poll(() => markerShown(page)).toBe(false);
    await expect(main(page)).not.toHaveAttribute("aria-busy");
    await page.getByRole("button", { name: "Background action" }).click();
    await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 2");
  });

  test("Back abandons a pending navigation, even when it lands on the same page", async ({ page }) => {
    await openShell(page);
    // A history entry on the same path, so Back stays on this page.
    await page.evaluate(() => history.pushState(null, "", "/dev/shell?step=1"));
    await page.locator("aside").getByRole("link", { name: /Team/ }).click();
    await expect.poll(() => markerShown(page)).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/\/dev\/shell$/);
    await expect.poll(() => markerShown(page)).toBe(false);
    await expect(main(page)).not.toHaveAttribute("aria-busy");
    await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 1"); // same page instance
  });

  test("a modified click (new tab) starts nothing here", async ({ page, context }) => {
    await openShell(page);
    context.on("page", (opened) => void opened.close());
    const run = page.locator("aside").getByRole("link", { name: /Faculty/ });
    await run.click({ modifiers: ["ControlOrMeta"] });
    await expect(main(page)).not.toHaveAttribute("aria-busy");
    await page.waitForTimeout(DELAY_MS + 250);
    expect(await markerShown(page)).toBe(false);
    await expect(main(page)).not.toHaveAttribute("aria-busy");
  });

  test("the current page's own link starts nothing", async ({ page }) => {
    await openShell(page);
    await page.evaluate(() => history.pushState(null, "", "/director/goals"));
    const current = page.locator("aside").getByRole("link", { name: /Goals/ });
    const run = await clickAndWatch(current, { watchMs: DELAY_MS + 300 });
    expect(run.busySoonAfterClick).toBeNull();
    expect(run.shownAfterMs).toBeNull();
    expect(run.busyAtEnd).toBeNull();
  });
});

test.describe("navigation pending marker in the mobile drawer", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 375, height: 812 });
  });

  test("the drawer closes at once and the marker shows in the header, in view", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    await drawer(page).getByRole("link", { name: /Placements/ }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(main(page)).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => markerShown(page)).toBe(true);
    await expect(marker(page)).toBeInViewport();
    expect(await marker(page).evaluate((el) => el.closest("header") !== null)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
});

test.describe("navigation pending marker with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  test("the same timer, the same static marker", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openShell(page);
    const run = await clickAndWatch(page.locator("aside").getByRole("link", { name: /Forecast/ }), { watchMs: 600 });
    expect(run.shownAfterMs!).toBeGreaterThanOrEqual(DELAY_MS - 5);
    expect(run.shownAtEnd).toBe(true);
    expect(await marker(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  });
});

// ─── Toasts in the shell ─────────────────────────────────────────────────

test.describe("toasts in the portal shell", () => {
  test("a toast raised while the drawer is open waits, unrendered, until it closes — and never takes focus", async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 375, height: 812 });
    await openShell(page);
    const region = page.getByRole("region", { name: "Notifications" });
    const list = region.locator("ol[aria-live=polite]");
    await expect(list).toBeAttached(); // the live region exists before any message

    await page.getByRole("button", { name: "Save review (toast in 1s)" }).click();
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(list.locator("li")).toHaveCount(0); // nothing behind the inert page

    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(list.locator("li")).toHaveCount(1);
    await expect(list.locator("li")).toContainText("Semester review saved.");
    await expect(menuButton(page)).toBeFocused(); // focus stayed where the drawer returned it
  });
});
