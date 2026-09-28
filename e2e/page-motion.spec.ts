import { expect, test, type Locator, type Page } from "@playwright/test";

// M3 (Checkpoint 4): page-level motion cleanup, verified in a browser on the
// pages reachable without a session (owner decision D3 keeps the portal
// pages out of reach): no page fades in, the route loading screen is static,
// and the auth forms' inputs use motion-feedback, so their focus ring is
// never animated. The portal pages themselves are covered statically by
// tests/motion-contract.test.ts.

const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const COLOURS = ["color", "background-color", "border-color", "outline-color", "fill", "stroke"];

/** A CSS <time> as milliseconds (the stylesheet is minified: 100ms reads back as ".1s"). */
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

/** Elements that declare a CSS animation, and any animation currently running on the page. */
async function pageMotion(page: Page) {
  return page.evaluate(() => ({
    animated: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => getComputedStyle(el).animationName !== "none")
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)} → ${getComputedStyle(el).animationName}`),
    running: document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => ((a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.constructor.name)),
  }));
}

const PAGES = [
  { path: "/login", ready: (page: Page) => page.getByLabel("Institutional Email") },
  { path: "/auth/reset-password", ready: (page: Page) => page.locator("input").first() },
  { path: "/dev/gallery", ready: (page: Page) => page.getByTestId("resource-status") },
];

for (const { path, ready } of PAGES) {
  test(`${path} renders directly: nothing animates on load`, async ({ page }) => {
    await page.goto(path);
    await expect(ready(page)).toBeVisible();
    const motion = await pageMotion(page);
    expect(motion.animated).toEqual([]);
    expect(motion.running).toEqual([]);
  });
}

test.describe("route loading screen (app/loading.tsx)", () => {
  test("is static — no pulse, no spin — and keeps its size and message", async ({ page }) => {
    await page.goto("/dev/gallery");
    const screen = page.getByTestId("loading-screen");
    await screen.scrollIntoViewIfNeeded();
    await expect(screen.getByText("Loading Academic Nexus...")).toBeVisible();

    const state = await screen.evaluate((root) => ({
      animated: [root, ...root.querySelectorAll("*")].filter((el) => getComputedStyle(el).animationName !== "none").length,
      running: root.getAnimations({ subtree: true }).length,
      icon: root.querySelectorAll('svg[aria-hidden="true"]').length,
    }));
    expect(state).toEqual({ animated: 0, running: 0, icon: 1 });

    // The tile keeps its 48×48 footprint, so removing the motion shifts nothing.
    const tile = screen.locator("svg").locator("..");
    const box = await tile.boundingBox();
    expect(box?.width).toBe(48);
    expect(box?.height).toBe(48);
  });
});

async function feedbackOf(input: Locator) {
  return input.evaluate((el) => {
    const s = getComputedStyle(el);
    return { property: s.transitionProperty, duration: s.transitionDuration, easing: s.transitionTimingFunction };
  });
}

const FORMS = [
  { path: "/login", inputs: (page: Page) => [page.getByLabel("Institutional Email"), page.getByLabel("Password")] },
  { path: "/auth/reset-password", inputs: (page: Page) => [page.locator("input").nth(0), page.locator("input").nth(1)] },
];

for (const { path, inputs } of FORMS) {
  test(`${path}: inputs use motion-feedback and their focus ring appears at once`, async ({ page }) => {
    await page.goto(path);
    for (const input of inputs(page)) {
      await expect(input).toBeVisible();
      const t = await feedbackOf(input);
      expect(t.property.split(",").map((p) => p.trim())).toEqual(COLOURS);
      expect(toMs(t.duration)).toBe(100);
      expect(t.easing).toBe(EASE_OUT);

      const focus = await input.evaluate((el: HTMLInputElement) => {
        el.focus();
        return {
          ring: getComputedStyle(el).boxShadow,
          transitioning: el.getAnimations().map((a) => (a as CSSTransition).transitionProperty),
        };
      });
      expect(focus.ring).toContain("rgb(0, 81, 213)"); // fully there in the same frame
      expect(focus.transitioning).not.toContain("box-shadow");
    }
  });
}

test.describe("with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  for (const { path, inputs } of FORMS) {
    test(`${path}: input feedback finishes immediately`, async ({ page }) => {
      await page.goto(path);
      for (const input of inputs(page)) {
        await expect(input).toBeVisible();
        for (const ms of (await feedbackOf(input)).duration.split(",").map(toMs)) expect(ms).toBeLessThanOrEqual(0.01);
      }
    });
  }

  test("pages still render directly and the loading screen stays static", async ({ page }) => {
    await page.goto("/dev/gallery");
    await expect(page.getByTestId("resource-status")).toHaveText("success");
    const motion = await pageMotion(page);
    expect(motion.animated).toEqual([]);
    await expect(page.getByTestId("loading-screen").getByText("Loading Academic Nexus...")).toBeVisible();
  });
});

test("login: the form is usable at once — no fade delays the first interaction", async ({ page }) => {
  await page.goto("/login");
  const email = page.getByLabel("Institutional Email");
  await email.fill("registrar@example.edu");
  await expect(email).toHaveValue("registrar@example.edu");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
});
