import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// M6.1: the feedback foundation in a browser, on the development gallery's
// demos (owner decision D3 keeps portal pages out of reach): Alert
// announcements through live regions that exist before their message,
// errors that never dismiss themselves, Dismiss from the keyboard, the
// motion-appear entrance and reduced motion, and StateView keeping "could
// not load" apart from "nothing here". Markup is unit-tested in
// tests/feedback-components.test.ts.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** A CSS <time> as milliseconds (the stylesheet is minified: 150ms reads back as ".15s"). */
function toMs(value: string): number {
  const match = /^(-?[\d.e-]+)(ms|s)$/.exec(value.trim());
  if (!match) throw new Error(`not a CSS time: "${value}"`);
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

// Every test fails on a console error or warning, hydration mismatches included.
const consoleMessages = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  consoleMessages.set(page, messages);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") messages.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => messages.push(`[pageerror] ${e.message}`));
});
test.afterEach(({ page }) => {
  expect(consoleMessages.get(page), "console errors or warnings").toEqual([]);
});

async function openGallery(page: Page) {
  await page.goto("/dev/gallery");
  // Hydrated: the async-resource demo only reaches "success" from a client effect.
  await expect(page.getByTestId("resource-status")).toHaveText("success");
  await page.getByTestId("gallery-feedback").scrollIntoViewIfNeeded();
}

const statusRegion = (page: Page) => page.getByTestId("alert-demo-status").locator('[role="status"]');
const errorRegion = (page: Page) => page.getByTestId("alert-demo-error").locator('[role="alert"]');
const show = (page: Page, name: string) => page.getByTestId("alert-demo").getByRole("button", { name }).click();

/** The live-region semantics Chromium exposes to assistive technology for the element. */
async function liveRegion(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const node = nodes[0];
    const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value.value]));
    return { role: node.role?.value, ignored: node.ignored, live: props.live as string | undefined };
  } finally {
    await cdp.detach();
  }
}

/** Clicks a demo button and reads the transitions the inserted message box starts with. */
async function showAndReadEntrance(page: Page, button: string, region: string) {
  return page.evaluate(
    ([name, regionSelector]) =>
      new Promise<Array<{ property: string; duration: number; keyframes: string }>>((resolve) => {
        const target = [...document.querySelectorAll("[data-testid=alert-demo] button")].find((b) => b.textContent === name) as HTMLElement;
        target.click();
        requestAnimationFrame(() => {
          const box = document.querySelector(`${regionSelector} [data-tone]`)!;
          resolve(
            box.getAnimations().map((a) => ({
              property: (a as CSSTransition).transitionProperty,
              duration: Number(a.effect?.getTiming().duration),
              keyframes: JSON.stringify((a.effect as KeyframeEffect).getKeyframes().map((k) => k.opacity)),
            }))
          );
        });
      }),
    [button, region] as const
  );
}

// ─── Alert ───────────────────────────────────────────────────────────────

test.describe("Alert", () => {
  test("a status message is announced politely, through a live region that existed before it", async ({ page }) => {
    await openGallery(page);
    const region = statusRegion(page);
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText("");
    const before = await liveRegion(page, '[data-testid="alert-demo-status"] [role="status"]');
    expect(before).toMatchObject({ role: "status", ignored: false, live: "polite" });
    const node = await region.elementHandle();

    for (const [button, text] of [
      ["Show success", "Success: Leave application submitted for 12–14 March."],
      ["Show info", "Information: Attendance for CS301 closes at 6:00 pm today."],
      ["Show warning", "Warning: 3 students in this section are below 75% attendance."],
    ] as const) {
      await show(page, button);
      await expect(region).toHaveText(text);
      // The same element, not a new one: the message went into the existing live region.
      expect(await node!.evaluate((el) => el.isConnected && el.textContent)).toBe(text);
      expect(await liveRegion(page, '[data-testid="alert-demo-status"] [role="status"]')).toMatchObject({ role: "status", live: "polite" });
    }
  });

  test("an error is announced assertively, with role=alert", async ({ page }) => {
    await openGallery(page);
    const region = errorRegion(page);
    await expect(region).toHaveText("");
    expect(await liveRegion(page, '[data-testid="alert-demo-error"] [role="alert"]')).toMatchObject({ role: "alert", ignored: false, live: "assertive" });

    await show(page, "Show error");
    await expect(region).toHaveText("Error: Marks could not be saved. Your entries are still here; try again.");
    expect(await liveRegion(page, '[data-testid="alert-demo-error"] [role="alert"]')).toMatchObject({ role: "alert", live: "assertive" });
  });

  test("messages never dismiss themselves, however long they stay", async ({ page }) => {
    await page.clock.install();
    await openGallery(page);
    await show(page, "Show success");
    await show(page, "Show error");
    await page.clock.runFor(10 * 60_000);
    await expect(statusRegion(page)).toContainText("Leave application submitted");
    await expect(errorRegion(page)).toContainText("Marks could not be saved");
  });

  test("Dismiss works from the keyboard, and focus stays where the message was", async ({ page }) => {
    await openGallery(page);
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el === document.body || !el ? "body" : `${el.getAttribute("role") ?? el.tagName}@${el.closest("[data-testid]")?.getAttribute("data-testid")}`;
      });

    await show(page, "Show error");
    await errorRegion(page).getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await expect(errorRegion(page)).toHaveText("");
    expect(await focused()).toBe("alert@alert-demo-error");

    await show(page, "Show success");
    await statusRegion(page).getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Space");
    await expect(statusRegion(page)).toHaveText("");
    expect(await focused()).toBe("status@alert-demo-status");

    // The region is not a Tab stop of its own: Tab moves on to the next control.
    await page.keyboard.press("Tab");
    expect(await focused()).not.toMatch(/^(status|alert)@/);
  });

  test("success, info and warning fade in: 150ms of opacity from 0, nothing else", async ({ page }) => {
    await openGallery(page);
    for (const button of ["Show success", "Show info", "Show warning"]) {
      const entrance = await showAndReadEntrance(page, button, '[data-testid="alert-demo-status"]');
      expect(entrance).toEqual([{ property: "opacity", duration: 150, keyframes: '["0","1"]' }]);
      const style = await statusRegion(page).locator("[data-tone]").evaluate((el) => {
        const s = getComputedStyle(el);
        return { property: s.transitionProperty, duration: s.transitionDuration, easing: s.transitionTimingFunction };
      });
      expect(style.property).toBe("opacity");
      expect(toMs(style.duration)).toBe(150);
      expect(style.easing).toBe("cubic-bezier(0, 0, 0.2, 1)");
      await statusRegion(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(statusRegion(page)).toHaveText("");
    }
    // The region itself never moves.
    expect(await statusRegion(page).evaluate((el) => el.getAnimations().length)).toBe(0);
  });

  test("an error appears at once: no transition, no animation", async ({ page }) => {
    await openGallery(page);
    expect(await showAndReadEntrance(page, "Show error", '[data-testid="alert-demo-error"]')).toEqual([]);
    const duration = await errorRegion(page).locator("[data-tone]").evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(toMs(duration)).toBe(0);
  });

  test("the loading state is static", async ({ page }) => {
    await openGallery(page);
    const loading = page.getByTestId("example-loading").locator("[data-loading-state]");
    const motion = await loading.evaluate((el) => ({
      animations: el.getAnimations({ subtree: true }).length,
      animation: getComputedStyle(el).animationName,
    }));
    expect(motion).toEqual({ animations: 0, animation: "none" });
  });
});

test.describe("Alert with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a status message appears without fading", async ({ page }) => {
    await openGallery(page);
    const entrance = await showAndReadEntrance(page, "Show success", '[data-testid="alert-demo-status"]');
    for (const { duration } of entrance) expect(duration).toBeLessThanOrEqual(0.01);
    const duration = await statusRegion(page).locator("[data-tone]").evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(toMs(duration)).toBeLessThanOrEqual(0.01);
    await expect(statusRegion(page)).toContainText("Leave application submitted");
    await expect(statusRegion(page).locator("[data-tone]")).toHaveCSS("opacity", "1");
  });
});

// ─── StateView ───────────────────────────────────────────────────────────

const demo = (page: Page) => page.getByTestId("state-view-demo");
const view = (page: Page) => demo(page).locator("[data-view]");
const announcer = (page: Page) => demo(page).locator('p[role="status"]');
const load = (page: Page, name: string) => demo(page).getByRole("button", { name }).click();

async function expectView(region: Locator, name: string, busy: boolean) {
  await expect(region).toHaveAttribute("data-view", name);
  if (busy) await expect(region).toHaveAttribute("aria-busy", "true");
  else await expect(region).not.toHaveAttribute("aria-busy");
}

test.describe("StateView", () => {
  test("a failed load is an error with Try again, never the empty state; Try again recovers", async ({ page }) => {
    await openGallery(page);
    await expectView(view(page), "data", false);

    await load(page, "Fresh load: fails once");
    await expectView(view(page), "loading", true);
    await expect(view(page)).toContainText("Loading refund requests…");

    await expectView(view(page), "error", false);
    const alert = view(page).locator("[data-error-state]");
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("This couldn't be loaded");
    await expect(view(page)).not.toContainText("No refund requests");

    await alert.getByRole("button", { name: "Try again" }).click();
    await expectView(view(page), "loading", true);
    await expectView(view(page), "data", false);
    await expect(page.getByTestId("state-view-records")).toContainText("Asha Rao");
  });

  test("a successful load that finds nothing is the empty state, with no alert", async ({ page }) => {
    await openGallery(page);
    await load(page, "Fresh load: nothing");
    await expectView(view(page), "empty", false);
    await expect(view(page)).toContainText("No refund requests");
    // No alert shown: the refresh-error region is there, empty, and nothing else alerts.
    await expect(view(page).getByRole("alert")).toHaveCount(1);
    await expect(view(page).getByRole("alert")).toHaveText("");
    await expect(view(page).locator("[data-error-state], [role=alert] [data-tone]")).toHaveCount(0);
  });

  test("a refresh keeps earlier records while busy; if it fails they stay, beside an error with Try again", async ({ page }) => {
    await openGallery(page);
    await expectView(view(page), "data", false);

    await load(page, "Refresh: fails");
    await expectView(view(page), "data", true);
    await expect(view(page)).toContainText("Refreshing…");
    await expect(page.getByTestId("state-view-records")).toContainText("Asha Rao");

    await expect(view(page).getByRole("alert")).toContainText("This couldn't be refreshed");
    await expectView(view(page), "data", false);
    await expect(page.getByTestId("state-view-records")).toContainText("Asha Rao");
    await expect(view(page)).not.toContainText("No refund requests");

    await view(page).getByRole("alert").getByRole("button", { name: "Try again" }).click();
    await expect(view(page).getByRole("alert")).toContainText("This couldn't be refreshed");
  });

  test("a failed refresh after an empty result is an error, not empty", async ({ page }) => {
    await openGallery(page);
    await load(page, "Refresh: nothing");
    await expectView(view(page), "empty", false);
    await load(page, "Refresh: fails");
    await expectView(view(page), "error", false);
    await expect(view(page)).not.toContainText("No refund requests");
    const failed = view(page).locator("[data-error-state]");
    await expect(failed).toHaveAttribute("role", "alert");
    await expect(failed).toContainText("This couldn't be loaded");
  });

  test("only a load the user asked for is announced, from a status region that is always there", async ({ page }) => {
    await openGallery(page);
    await expect(announcer(page)).toHaveCount(1);
    await expect(announcer(page)).toHaveText("");

    // A fresh (passive) load: busy, but silent. Read once while it is busy —
    // a retrying assertion would pass as soon as the load ended.
    await load(page, "Fresh load: records");
    await expectView(view(page), "loading", true);
    expect(await announcer(page).textContent()).toBe("");
    await expectView(view(page), "data", false);

    // A refresh the user asked for: announced while it runs, then cleared.
    await load(page, "Refresh: records");
    await expect(announcer(page)).toHaveText("Loading refund requests…");
    await expect(view(page)).toHaveAttribute("aria-busy", "true");
    // While the region is busy, the announcer sits outside it, so aria-busy does not silence it.
    expect(await announcer(page).evaluate((el) => el.closest("[aria-busy]") === null)).toBe(true);
    await expectView(view(page), "data", false);
    await expect(announcer(page)).toHaveText("");
  });
});

// ─── axe ─────────────────────────────────────────────────────────────────

test("every feedback state passes an axe WCAG 2.2 AA scan", async ({ page }) => {
  await openGallery(page);
  const scan = async (state: string) => {
    const { violations } = await new AxeBuilder({ page }).include('[data-testid="gallery-feedback"]').withTags(WCAG_TAGS).analyze();
    expect(violations.map((v) => `${state}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  };

  await scan("at rest");
  await show(page, "Show success");
  await show(page, "Show error");
  await scan("success and error shown");
  await show(page, "Show warning");
  await scan("warning shown");

  await load(page, "Fresh load: fails once");
  await expectView(view(page), "loading", true);
  await scan("loading");
  await expectView(view(page), "error", false);
  await scan("error");
  await load(page, "Fresh load: nothing");
  await expectView(view(page), "empty", false);
  await scan("empty");
  await load(page, "Fresh load: records");
  await expectView(view(page), "data", false);
  await load(page, "Refresh: fails");
  await expect(view(page).getByRole("alert")).toBeVisible();
  await scan("refresh failed over records");
});
