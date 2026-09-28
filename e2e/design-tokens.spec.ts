import { expect, test, type Page } from "@playwright/test";

// Foundation Stage 2, verified in a real browser: self-hosted fonts, the
// global keyboard-focus ring, lifecycle semantics and reduced motion.

/** A CSS <time> as milliseconds: the stylesheet is minified, so 100ms may read back as ".1s". */
function toMs(value: string): number {
  const match = /^(-?[\d.e-]+)(ms|s)$/.exec(value.trim());
  if (!match) throw new Error(`not a CSS time: "${value}"`);
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

async function collectConsole(page: Page): Promise<string[]> {
  const messages: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") messages.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => messages.push(`[pageerror] ${e.message}`));
  return messages;
}

for (const path of ["/login", "/dev/gallery"]) {
  test(`${path} uses the self-hosted fonts with no console errors or hydration warnings`, async ({ page }) => {
    const messages = await collectConsole(page);
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);

    const fonts = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      googleLinks: document.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').length,
      loadedInter: [...document.fonts].some((f) => f.status === "loaded" && /Inter/.test(f.family)),
    }));
    expect(fonts.googleLinks).toBe(0);
    expect(fonts.body).toMatch(/Inter/);
    expect(fonts.loadedInter).toBe(true);

    // Nothing may be logged: in particular no hydration mismatch from the
    // font class names or anything else rendered differently on the server.
    expect(messages).toEqual([]);
  });
}

test("keyboard focus shows the 2px focus ring, offset from the element", async ({ page }) => {
  await page.goto("/login");
  const google = page.getByRole("button", { name: "Continue with Google" });

  // Tab until the first button has keyboard focus.
  for (let i = 0; i < 10 && !(await google.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(google).toBeFocused();

  // Polled: the button's transition-colors also eases the ring's colour in.
  await expect
    .poll(() =>
      google.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
      }),
    )
    .toEqual({ style: "solid", width: "2px", color: "rgb(0, 81, 213)", offset: "2px" });
});

test("a text field that replaces the outline still shows a focus ring", async ({ page }) => {
  await page.goto("/login");
  const email = page.getByLabel("Institutional Email");
  await email.focus();
  // The field's own ring (outline-none + focus:ring-2) — polled while it eases in.
  await expect.poll(() => email.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("rgb(0, 81, 213) 0px 0px 0px 2px");
});

test("lifecycle: closed is neutral with a lock, never an error", async ({ page }) => {
  await page.goto("/dev/gallery");
  const section = page.getByTestId("gallery-lifecycle");

  const closed = section.getByText("closed", { exact: true });
  await expect(closed).toBeVisible();
  await expect(closed.locator('svg[data-icon="lock"]')).toHaveCount(1);
  await expect(closed).not.toHaveClass(/error/);
  await expect(closed).toHaveClass(/bg-neutral-container/);

  await expect(section.getByText("planned", { exact: true })).toHaveClass(/bg-info-container/);
  await expect(section.getByText("active", { exact: true })).toHaveClass(/bg-success-container/);
  await expect(section.getByText("reopened", { exact: true })).toHaveClass(/bg-warning-container/);
});

test.describe("with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  test("motion tokens are zero and transitions finish immediately", async ({ page }) => {
    await page.goto("/dev/gallery");
    const values = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const button = document.querySelector('[data-testid="gallery-buttons"] button');
      return {
        tokens: ["instant", "fast", "normal", "slow"].map((n) => root.getPropertyValue(`--duration-${n}`).trim()),
        buttonTransition: button ? getComputedStyle(button).transitionDuration : null,
        scrollBehavior: root.scrollBehavior,
      };
    });
    expect(values.tokens.map(toMs)).toEqual([0, 0, 0, 0]);
    expect(toMs(values.buttonTransition ?? "")).toBeLessThanOrEqual(0.01);
    expect(values.scrollBehavior).toBe("auto");
  });
});

test("without a reduced-motion preference the motion tokens keep their values", async ({ page }) => {
  await page.goto("/dev/gallery");
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return ["instant", "fast", "normal", "slow"].map((n) => root.getPropertyValue(`--duration-${n}`).trim());
  });
  expect(tokens.map(toMs)).toEqual([100, 150, 200, 300]);
});
