import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Checkpoint 4, M1: the four semantic motion utilities, verified on the
// development gallery's bare demo elements — the computed transitions, a
// native <dialog> entering and leaving, the reduced-motion contract — and
// the placement funnel chart no longer animating.

const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const EASE_IN_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";
const EASE_EMPHASIZED = "cubic-bezier(0.2, 0, 0, 1)";
const MAX_MS = 300;

/** A CSS <time> as milliseconds (the stylesheet is minified: 100ms reads back as ".1s"). */
function toMs(value: string): number {
  const match = /^(-?[\d.e-]+)(ms|s)$/.exec(value.trim());
  if (!match) throw new Error(`not a CSS time: "${value}"`);
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

type Transition = { properties: string[]; durations: number[]; easings: string[]; behavior: string };

async function transitionOf(locator: Locator, pseudo?: string): Promise<Transition> {
  const raw = await locator.evaluate((el, p) => {
    const s = getComputedStyle(el, p ?? null);
    return { property: s.transitionProperty, duration: s.transitionDuration, easing: s.transitionTimingFunction, behavior: s.transitionBehavior };
  }, pseudo);
  return {
    properties: raw.property.split(",").map((v) => v.trim()),
    durations: raw.duration.split(",").map(toMs),
    easings: raw.easing.split(/,\s*(?![^(]*\))/).map((v) => v.trim()),
    behavior: raw.behavior,
  };
}

function expectTransition(actual: Transition, expected: { properties: string[]; ms: number; easing: string }) {
  expect(actual.properties).toEqual(expected.properties);
  expect(actual.properties).not.toContain("all");
  for (const ms of actual.durations) {
    expect(ms).toBe(expected.ms);
    expect(ms).toBeLessThanOrEqual(MAX_MS);
  }
  for (const easing of actual.easings) expect(easing).toBe(expected.easing);
}

const COLOURS = ["color", "background-color", "border-color", "outline-color", "fill", "stroke"];

// Every test in this file fails on a console error or warning — a hydration
// mismatch in particular — not only the dedicated console test below.
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
  await expect(page.getByTestId("gallery-motion-utilities")).toBeVisible();
  // Wait for hydration: the async-resource demo only reaches "success" from
  // a client effect. Calling showModal() on server-rendered HTML before then
  // would leave an `open` attribute React never rendered (a hydration mismatch).
  await expect(page.getByTestId("resource-status")).toHaveText("success");
}

/**
 * Opens (showModal) or closes a dialog and, in the SAME task, lists the CSS
 * transitions that started on it and its ::backdrop — read before any of
 * them can finish, however slow the machine — plus its display right after.
 */
async function toggleDialog(dialog: Locator, action: "open" | "close") {
  return dialog.evaluate((el: HTMLDialogElement, act) => {
    if (act === "open") el.showModal();
    else el.close();
    const display = getComputedStyle(el).display; // also flushes style, starting the transitions
    const transitions = document
      .getAnimations()
      .filter((a) => a instanceof CSSTransition && (a.effect as KeyframeEffect | null)?.target === el)
      .map((a) => {
        const effect = a.effect as KeyframeEffect;
        return { property: (a as CSSTransition).transitionProperty, pseudo: effect.pseudoElement ?? "", ms: Number(effect.getTiming().duration) };
      });
    return { display, transitions };
  }, action);
}

test.describe("motion utilities: computed transitions", () => {
  test("motion-feedback: colours only, 100ms, ease-out", async ({ page }) => {
    await openGallery(page);
    expectTransition(await transitionOf(page.getByTestId("motion-feedback-demo")), { properties: COLOURS, ms: 100, easing: EASE_OUT });
  });

  test("motion-state: colours and opacity, 150ms, ease-in-out", async ({ page }) => {
    await openGallery(page);
    expectTransition(await transitionOf(page.getByTestId("motion-state-demo")), {
      properties: [...COLOURS, "opacity"],
      ms: 150,
      easing: EASE_IN_OUT,
    });
  });

  test("motion-dialog: exits in 150ms ease-in-out, enters in 200ms ease-emphasized, discrete display/overlay", async ({ page }) => {
    await openGallery(page);
    const dialog = page.getByTestId("motion-dialog-demo");
    const closed = await transitionOf(dialog);
    expectTransition(closed, { properties: ["opacity", "transform", "display", "overlay"], ms: 150, easing: EASE_IN_OUT });
    expect(closed.behavior).toBe("allow-discrete");

    await page.getByRole("button", { name: "Open motion-dialog" }).click();
    await expect(dialog).toBeVisible();
    expectTransition(await transitionOf(dialog), { properties: ["opacity", "transform", "display", "overlay"], ms: 200, easing: EASE_EMPHASIZED });
    expectTransition(await transitionOf(dialog, "::backdrop"), { properties: ["opacity", "display", "overlay"], ms: 200, easing: EASE_EMPHASIZED });
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  });

  test("motion-drawer: exits in 200ms ease-in-out, enters in 300ms ease-emphasized, transform only", async ({ page }) => {
    await openGallery(page);
    const drawer = page.getByTestId("motion-drawer-demo");
    const closed = await transitionOf(drawer);
    expectTransition(closed, { properties: ["transform", "display", "overlay"], ms: 200, easing: EASE_IN_OUT });
    expect(closed.behavior).toBe("allow-discrete");

    await page.getByRole("button", { name: "Open motion-drawer" }).click();
    await expect(drawer).toBeVisible();
    expectTransition(await transitionOf(drawer), { properties: ["transform", "display", "overlay"], ms: 300, easing: EASE_EMPHASIZED });
    expectTransition(await transitionOf(drawer, "::backdrop"), { properties: ["opacity", "display", "overlay"], ms: 300, easing: EASE_EMPHASIZED });
  });
});

test.describe("motion utilities: a native <dialog> enters and leaves", () => {
  test("opening runs 200ms transitions on the dialog and its backdrop; closing keeps it rendered for the 150ms exit", async ({ page }) => {
    await openGallery(page);
    const dialog = page.getByTestId("motion-dialog-demo");

    const entering = (await toggleDialog(dialog, "open")).transitions;
    expect(entering).toEqual(
      expect.arrayContaining([
        { property: "opacity", pseudo: "", ms: 200 },
        { property: "transform", pseudo: "", ms: 200 },
        { property: "opacity", pseudo: "::backdrop", ms: 200 },
      ]),
    );
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    const leaving = await toggleDialog(dialog, "close");
    expect(leaving.display).not.toBe("none"); // still on screen while it fades out
    expect(leaving.transitions.find((t) => t.property === "opacity" && t.pseudo === "")?.ms).toBe(150);
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  });

  test("keyboard: focus is inside the dialog at once, Escape closes it, focus returns to the opener", async ({ page }) => {
    await openGallery(page);
    const opener = page.getByRole("button", { name: "Open motion-dialog" });
    await opener.focus();
    await page.keyboard.press("Enter");

    // No waiting for the enter transition: focus moves in the same frame.
    const focusInside = await page.getByTestId("motion-dialog-demo").evaluate((el) => el.contains(document.activeElement));
    expect(focusInside).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("motion-dialog-demo")).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

test.describe("with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  test("every motion utility finishes immediately", async ({ page }) => {
    await openGallery(page);
    for (const id of ["motion-feedback-demo", "motion-state-demo", "motion-dialog-demo", "motion-drawer-demo"]) {
      const { durations } = await transitionOf(page.getByTestId(id));
      for (const ms of durations) expect(ms, id).toBeLessThanOrEqual(0.01);
    }
  });

  test("a native <dialog> and its backdrop open and close without a visible transition", async ({ page }) => {
    await openGallery(page);
    const dialog = page.getByTestId("motion-dialog-demo");

    const opening = await toggleDialog(dialog, "open");
    for (const t of opening.transitions) expect(t.ms, `${t.pseudo}${t.property}`).toBeLessThanOrEqual(0.01);
    const backdrop = await transitionOf(dialog, "::backdrop");
    for (const ms of backdrop.durations) expect(ms).toBe(0);
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity), { timeout: 1_000 }).toBe("1");

    const closing = await toggleDialog(dialog, "close");
    for (const t of closing.transitions) expect(t.ms, `${t.pseudo}${t.property}`).toBeLessThanOrEqual(0.01);
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).display), { timeout: 1_000 }).toBe("none");
  });
});

// ─── Placement funnel chart ──────────────────────────────────────────────

/** The funnel's trapezoids and value labels, the moment they first render. */
async function funnelSnapshot(page: Page) {
  return page.getByTestId("funnel-chart").evaluate((root) => ({
    shapes: [...root.querySelectorAll(".recharts-funnel-trapezoid path")].map((p) => p.getAttribute("d")),
    labels: [...root.querySelectorAll(".recharts-label-list text")].map((t) => t.textContent),
  }));
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test.describe(`placement funnel chart (${reducedMotion})`, () => {
    test.use({ reducedMotion });

    test("renders its final shape and labels in the first frame and never changes", async ({ page }) => {
      await page.goto("/dev/gallery");
      const chart = page.getByTestId("funnel-chart");
      await chart.scrollIntoViewIfNeeded();
      await expect(chart.locator(".recharts-funnel-trapezoid path").first()).toBeAttached();

      // Recharts draws the value labels only once an animation has finished,
      // so labels present at first render mean there was no animation.
      const first = await funnelSnapshot(page);
      expect(first.shapes).toHaveLength(5);
      expect(first.labels).toEqual(expect.arrayContaining(["Eligible", "Placed", "420", "58"]));

      await page.waitForTimeout(1_700); // longer than Recharts' 1.5 s funnel animation
      expect(await funnelSnapshot(page)).toEqual(first);
    });
  });
}

test("the gallery, including opening and closing the motion demos, logs no errors or hydration warnings", async ({ page }) => {
  const messages: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") messages.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => messages.push(`[pageerror] ${e.message}`));

  await openGallery(page);
  for (const name of ["motion-dialog", "motion-drawer"]) {
    await page.getByRole("button", { name: `Open ${name}` }).click();
    await expect(page.getByTestId(`${name}-demo`)).toBeVisible();
    await page.getByTestId(`${name}-demo`).getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId(`${name}-demo`)).toBeHidden();
  }
  await page.getByRole("button", { name: "Toggle state" }).click();
  await expect(page.getByTestId("motion-state-demo")).toHaveText("Approved");

  expect(messages).toEqual([]);
});

test("the open motion dialog and drawer have no axe violations", async ({ page }) => {
  await openGallery(page);
  for (const name of ["motion-dialog", "motion-drawer"]) {
    const demo = page.getByTestId(`${name}-demo`);
    await page.getByRole("button", { name: `Open ${name}` }).click();
    // Settled: the enter transition has reached its resting (identity) transform.
    await expect.poll(() => demo.evaluate((el) => getComputedStyle(el).transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    const { violations } = await new AxeBuilder({ page })
      .include(`[data-testid="${name}-demo"]`)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations.map((v) => v.id), name).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(demo).toBeHidden();
  }
});

// ─── M2: the shared primitives on the semantic utilities ─────────────────

/**
 * Clicks "Change status" and lists the transitions that start on the
 * StatusBadge, read the moment React commits the new classes (a
 * MutationObserver callback) — before any 150ms transition could finish,
 * however slow the machine.
 */
async function changeStatus(page: Page) {
  return page.evaluate(
    () =>
      new Promise<Array<{ property: string; ms: number }>>((resolve) => {
        const section = document.querySelector('[data-testid="gallery-status-badges"]')!;
        const badge = section.querySelector('[data-testid="status-change"] span')!;
        const observer = new MutationObserver(() => {
          observer.disconnect();
          getComputedStyle(badge).backgroundColor; // flush style: start the transitions
          resolve(
            badge.getAnimations().map((a) => ({
              property: (a as CSSTransition).transitionProperty,
              ms: Number(a.effect?.getTiming().duration),
            })),
          );
        });
        observer.observe(badge, { attributes: true, attributeFilter: ["class"] });
        [...section.querySelectorAll("button")].find((btn) => btn.textContent === "Change status")!.click();
      }),
  );
}

/** Each migrated primitive in the gallery, with the utility it must carry. */
function primitives(page: Page): Array<{ name: string; locator: Locator; utility: "feedback" | "state" }> {
  const table = page.getByTestId("gallery-data-table").locator("> div").first();
  return [
    { name: "Button", locator: page.getByTestId("gallery-buttons").getByRole("button", { name: "primary" }), utility: "feedback" },
    { name: "Input", locator: page.locator("#g-text"), utility: "feedback" },
    { name: "Select", locator: page.locator("#g-select"), utility: "feedback" },
    { name: "Textarea", locator: page.locator("#g-textarea"), utility: "feedback" },
    { name: "DataTable search", locator: table.getByRole("textbox"), utility: "feedback" },
    { name: "DataTable sortable header", locator: table.locator("th").first(), utility: "feedback" },
    { name: "DataTable row", locator: table.locator("tbody tr").first(), utility: "feedback" },
    { name: "Pagination page", locator: table.getByRole("button", { name: "2", exact: true }), utility: "feedback" },
    { name: "Pagination next", locator: table.getByRole("button", { name: "Next" }), utility: "feedback" },
    { name: "StatusBadge", locator: page.getByTestId("status-change").locator("span").first(), utility: "state" },
  ];
}

test.describe("M2 primitives: computed transitions", () => {
  test("every migrated primitive transitions only colours (and opacity for state) at its token duration", async ({ page }) => {
    await openGallery(page);
    for (const { name, locator, utility } of primitives(page)) {
      await expect(locator, name).toBeVisible();
      const actual = await transitionOf(locator);
      expect(actual.properties, name).not.toContain("all");
      expect(actual.properties, name).not.toContain("box-shadow");
      expectTransition(
        actual,
        utility === "feedback"
          ? { properties: COLOURS, ms: 100, easing: EASE_OUT }
          : { properties: [...COLOURS, "opacity"], ms: 150, easing: EASE_IN_OUT },
      );
    }
  });

  test("a StatsCard does not move: no transition, no hover shadow, and a static progress bar", async ({ page }) => {
    await openGallery(page);
    const card = page.getByTestId("gallery-stats-cards").locator("> div > div").nth(1); // "Attendance", with progress
    const bar = card.locator('[style*="width"]');

    for (const target of [card, bar]) {
      const { durations } = await transitionOf(target);
      for (const ms of durations) expect(ms).toBe(0);
    }
    const before = await card.evaluate((el) => getComputedStyle(el).boxShadow);
    await card.hover();
    expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(before);
    expect(await bar.evaluate((el) => (el as HTMLElement).style.width)).toBe("86%");
    expect(await bar.evaluate((el) => el.getAnimations().length)).toBe(0);
  });

  test("an input's focus ring appears at once — box-shadow is never transitioned", async ({ page }) => {
    await openGallery(page);
    const input = page.locator("#g-text");
    const shadow = await input.evaluate((el: HTMLInputElement) => {
      el.focus();
      const style = getComputedStyle(el);
      return { now: style.boxShadow, transitions: el.getAnimations().map((a) => (a as CSSTransition).transitionProperty) };
    });
    expect(shadow.now).toContain("rgb(0, 81, 213)"); // the ring is fully there in the same frame
    expect(shadow.transitions).not.toContain("box-shadow");
  });

  test("StatusBadge: nothing moves on first render; a real status change runs a 150ms motion-state transition", async ({ page }) => {
    await openGallery(page);
    const badge = page.getByTestId("status-change").locator("span").first();
    await expect(badge).toHaveText("pending");
    expect(await badge.evaluate((el) => el.getAnimations().length)).toBe(0);

    const started = await changeStatus(page);
    expect(started.map((t) => t.property)).toEqual(expect.arrayContaining(["background-color", "color"]));
    for (const t of started) expect(t.ms, t.property).toBe(150);
    await expect(badge).toHaveText("approved");
    await expect(badge).toHaveClass(/bg-success-container/);
    await expect(badge).toBeVisible(); // the word stays readable throughout
  });

  test("keyboard: pagination is reachable and operable, and a disabled control stays disabled", async ({ page }) => {
    await openGallery(page);
    const table = page.getByTestId("gallery-data-table").locator("> div").first();
    const previous = table.getByRole("button", { name: "Previous" });
    await expect(previous).toBeDisabled();

    const pageTwo = table.getByRole("button", { name: "2", exact: true });
    await pageTwo.focus();
    await expect(pageTwo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(previous).toBeEnabled();
    await expect(page.getByTestId("gallery-buttons").getByRole("button", { name: "Disabled" })).toBeDisabled();
  });
});

test.describe("M2 primitives with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  test("every migrated primitive finishes its transition immediately, and stays visible", async ({ page }) => {
    await openGallery(page);
    for (const { name, locator } of primitives(page)) {
      await expect(locator, name).toBeVisible();
      const { durations } = await transitionOf(locator);
      for (const ms of durations) expect(ms, name).toBeLessThanOrEqual(0.01);
    }
  });

  test("a StatusBadge change is immediate", async ({ page }) => {
    await openGallery(page);
    const badge = page.getByTestId("status-change").locator("span").first();
    const started = await changeStatus(page);
    for (const t of started) expect(t.ms, t.property).toBeLessThanOrEqual(0.01);
    await expect(badge).toHaveText("approved");
    await expect(badge).toHaveClass(/bg-success-container/);
  });
});
