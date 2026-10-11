import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Checkpoint 4, M5: the portal shell's responsive navigation, verified on the
// development-only harness (app/dev/shell), which renders the real
// PortalShell for a fictional director. From 1024px (Tailwind `lg`) the
// sidebar is persistent and never animates its width; below it the same
// navigation is a native modal <dialog> drawer (motion-drawer) with the
// browser's top layer, focus handling, Escape and inert page.

const EASE_IN_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";
const EASE_EMPHASIZED = "cubic-bezier(0.2, 0, 0, 1)";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// The director's navigation, as in NAV_MAP (components/portal/portal-shell.tsx).
const DIRECTOR_LINKS = [
  ["Dashboard", "/director/dashboard"],
  ["Attention", "/director/attention"],
  ["Decisions", "/director/decisions"],
  ["Analytics", "/director/analytics"],
  ["Departments", "/director/departments"],
  ["Placements", "/director/placements/funnel"],
  ["Hostel", "/director/hostel"],
  ["Gate Security", "/director/security"],
  ["Team", "/director/team"],
  ["Faculty", "/director/faculty"],
  ["Goals", "/director/goals"],
  ["Ask the Institution", "/director/ask"],
  ["Forecast", "/director/forecast"],
  ["Briefing", "/director/briefing"],
];

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

async function openShell(page: Page, path = "/dev/shell") {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Hydrated: a client click handler responds (a click before hydration is lost, so retry until one lands).
  const log = page.getByTestId("shell-log");
  await expect(async () => {
    if ((await log.textContent()) === "Background clicks: 0") await page.getByRole("button", { name: "Background action" }).click();
    await expect(log).toHaveText("Background clicks: 1", { timeout: 500 });
  }).toPass();
}

const menuButton = (page: Page) => page.getByRole("button", { name: "Open menu" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Menu" });
const sidebar = (page: Page) => page.locator("aside");

/** Where focus is: "drawer:<label>" inside the open drawer, "document" on no element, else "page:<label>". */
async function focusPosition(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "document";
    const label = a.getAttribute("aria-label") || a.querySelector("span.truncate")?.textContent || a.textContent?.trim().slice(0, 24) || a.tagName;
    return `${a.closest("dialog[open]") ? "drawer" : "page"}:${label}`;
  });
}

/**
 * Clicks `button` and, when a dialog's `open` attribute next changes, lists the CSS transitions that started on it and its ::backdrop.
 *
 * Everything is read in the browser, in the callback that sees the change: on close the dialog is unmounted once its
 * exit has played, so a later Playwright call can arrive after it is gone and wait for it forever. On close it also
 * waits for those exit transitions to finish and reports whether the dialog was still in the page when they had.
 */
async function clickAndReadTransitions(button: Locator) {
  return button.evaluate(
    (el: HTMLElement) =>
      new Promise<{
        open: boolean;
        connected: boolean;
        easing: string;
        connectedWhenExitFinished: boolean | null;
        transitions: { property: string; pseudo: string; ms: number }[];
      }>((resolve) => {
        const observer = new MutationObserver((records) => {
          const dialog = records.map((r) => r.target).find((t): t is HTMLDialogElement => t instanceof HTMLDialogElement);
          if (!dialog) return;
          observer.disconnect();
          const started = document
            .getAnimations()
            .filter((a) => a instanceof CSSTransition && (a.effect as KeyframeEffect | null)?.target === dialog);
          const transitions = started.map((a) => {
            const effect = a.effect as KeyframeEffect;
            return { property: (a as CSSTransition).transitionProperty, pseudo: effect.pseudoElement ?? "", ms: Number(effect.getTiming().duration) };
          });
          const observed = { open: dialog.open, connected: dialog.isConnected, easing: getComputedStyle(dialog).transitionTimingFunction, transitions };
          if (dialog.open) {
            resolve({ ...observed, connectedWhenExitFinished: null });
            return;
          }
          // Settled whether a transition finishes or is cancelled (as removing the dialog would cancel it).
          Promise.allSettled(started.map((a) => a.finished)).then(() => resolve({ ...observed, connectedWhenExitFinished: dialog.isConnected }));
        });
        observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
        el.click();
      })
  );
}

// ─── Responsive contract ─────────────────────────────────────────────────

test.describe("responsive contract", () => {
  // Widths are set explicitly: both projects run them (the mobile one with touch emulation).

  for (const width of [375, 639, 640, 768, 1023, 1024, 1280]) {
    test(`${width}px: ${width >= 1024 ? "persistent sidebar, no menu button" : "menu button, sidebar hidden"}, no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openShell(page);
      if (width >= 1024) {
        await expect(sidebar(page)).toBeVisible();
        expect(Math.round((await sidebar(page).boundingBox())!.width)).toBe(256);
        await expect(menuButton(page)).toBeHidden();
        await expect(sidebar(page).getByRole("link")).toHaveCount(DIRECTOR_LINKS.length);
      } else {
        await expect(sidebar(page)).toBeHidden();
        await expect(menuButton(page)).toBeVisible();
        // The closed drawer is not in the page at all: no hidden links to tab into.
        await expect(page.locator("dialog")).toHaveCount(0);
        await expect(page.getByRole("link", { name: /Dashboard/ })).toHaveCount(0);
      }
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    });
  }
});

// ─── Desktop sidebar ─────────────────────────────────────────────────────

test.describe("desktop sidebar (1280px)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("lists the role's navigation with its labels and destinations", async ({ page }) => {
    await openShell(page);
    const links = sidebar(page).getByRole("link");
    expect(await links.evaluateAll((els) => els.map((a) => [a.querySelector("span.truncate")?.textContent, a.getAttribute("href")]))).toEqual(DIRECTOR_LINKS);
  });

  test("collapsing and expanding change the width at once: no transition, nothing animates, focus stays on the toggle", async ({ page }) => {
    await openShell(page);
    const aside = sidebar(page);
    expect(toMsList(await aside.evaluate((el) => getComputedStyle(el).transitionDuration))).toEqual([0]);

    for (const [name, width, labels] of [["Collapse sidebar", 72, 0], ["Expand sidebar", 256, DIRECTOR_LINKS.length]] as const) {
      const toggle = page.getByRole("button", { name });
      await toggle.focus();
      // Read in the same task as React commits the class change.
      const result = await aside.evaluate(
        (el, label) =>
          new Promise<{ width: number; running: number }>((resolve) => {
            new MutationObserver((_, observer) => {
              observer.disconnect();
              resolve({ width: el.getBoundingClientRect().width, running: el.getAnimations({ subtree: true }).filter((a) => a.effect && (a.effect as KeyframeEffect).target === el).length });
            }).observe(el, { attributes: true, attributeFilter: ["class"] });
            document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
          }),
        name
      );
      expect(result).toEqual({ width, running: 0 });
      await expect(aside.locator("nav a span.truncate")).toHaveCount(labels);
      await expect(page.getByRole("button", { name: name === "Collapse sidebar" ? "Expand sidebar" : "Collapse sidebar" })).toBeFocused();
    }
  });

  test("no drawer exists on desktop, and axe finds nothing", async ({ page }) => {
    await openShell(page);
    await expect(page.locator("dialog")).toHaveCount(0);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

function toMsList(value: string): number[] {
  return value.split(",").map((v) => {
    const m = /^(-?[\d.e-]+)(ms|s)$/.exec(v.trim());
    return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : NaN;
  });
}

// ─── Mobile drawer ────────────────────────────────────────────────────────

test.describe("mobile drawer", () => {
  // The mobile project runs these at 375px; the desktop project at 768px (tablet).
  test.beforeEach(async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 768, height: 800 });
  });

  test("opens as a native modal dialog carrying motion-drawer, with focus on its Close control", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    await expect.poll(() => drawer(page).evaluate((d) => Math.round(d.getBoundingClientRect().left))).toBe(0);
    const state = await drawer(page).evaluate((d: HTMLDialogElement) => ({
      open: d.open,
      modal: d.matches(":modal"),
      motion: d.classList.contains("motion-drawer"),
      role: d.getAttribute("role"),
      ariaModal: d.getAttribute("aria-modal"),
      zIndex: getComputedStyle(d).zIndex,
      left: Math.round(d.getBoundingClientRect().left),
      width: Math.round(d.getBoundingClientRect().width),
      height: Math.round(d.getBoundingClientRect().height),
      vh: innerHeight,
    }));
    expect(state).toEqual({ open: true, modal: true, motion: true, role: null, ariaModal: null, zIndex: "auto", left: 0, width: 256, height: state.vh, vh: state.vh });
    await expect(drawer(page).getByRole("button", { name: "Close menu" })).toBeFocused();
    expect(await drawer(page).getByRole("link").evaluateAll((els) => els.map((a) => [a.querySelector("span.truncate")?.textContent, a.getAttribute("href")]))).toEqual(DIRECTOR_LINKS);
  });

  test("opens from the keyboard; Tab and Shift+Tab cycle inside the drawer and never reach the page", async ({ page }) => {
    await openShell(page);
    await menuButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(drawer(page)).toBeVisible();
    expect(await focusPosition(page)).toBe("drawer:Close menu");

    const controls = ["drawer:Close menu", ...DIRECTOR_LINKS.map(([label]) => `drawer:${label}`)];
    for (const key of ["Tab", "Shift+Tab"]) {
      const stops: string[] = [];
      for (let i = 0; i < 2 * (controls.length + 1); i++) {
        await page.keyboard.press(key);
        stops.push(await focusPosition(page));
      }
      expect(stops.filter((s) => s.startsWith("page:"))).toEqual([]);
      // The one stop outside the drawer is the browser's own (focus leaves the document).
      expect(stops.filter((s) => s === "document").length).toBeLessThanOrEqual(2);
      expect(new Set(stops.filter((s) => s !== "document"))).toEqual(new Set(controls));
    }
  });

  test("Escape closes it and focus returns to the menu button", async ({ page }) => {
    await openShell(page);
    await menuButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    await expect(page.locator("dialog")).toHaveCount(0);
  });

  test("the Close control closes it and focus returns to the menu button", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await drawer(page).getByRole("button", { name: "Close menu" }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    await expect(page.locator("dialog")).toHaveCount(0);
  });

  test("the page behind is inert, a backdrop click closes the drawer and reaches nothing, and the page does not scroll", async ({ page }) => {
    await openShell(page);
    const background = page.locator("button", { hasText: "Background action" });
    const cdp = await page.context().newCDPSession(page);
    const exposed = async () => {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      return nodes.some((n) => n.name?.value === "Background action" && !n.ignored);
    };
    const mainScroll = () => page.locator("main").evaluate((el) => el.scrollTop);
    expect(await exposed()).toBe(true);
    const scrollBefore = await mainScroll();

    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    expect(await exposed()).toBe(false);
    expect(await background.evaluate((el: HTMLElement) => (el.focus(), document.activeElement === el))).toBe(false);

    // A point right of the drawer, over the page: only the ::backdrop is hit.
    const vw = await page.evaluate(() => innerWidth);
    const point = { x: vw - 24, y: 400 };
    expect(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).map((e) => e.tagName).filter((t) => !["HTML", "BODY"].includes(t)), point)).toEqual(["DIALOG"]);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 500);
    expect(await mainScroll()).toBe(scrollBefore);

    await page.evaluate(() => {
      const w = window as unknown as { leaked: string[] };
      w.leaked = [];
      document.addEventListener("click", (e) => { if (!(e.target as Element).closest("dialog")) w.leaked.push((e.target as Element).tagName); }, true);
    });
    await page.mouse.click(point.x, point.y);
    await expect(drawer(page)).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { leaked: string[] }).leaked)).toEqual([]);
    await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 1");
    await expect(menuButton(page)).toBeFocused();
  });

  test("choosing a link closes the drawer at once and navigates without waiting for the exit", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    // The portal routes need a session; the isolated test server has none, so
    // the request is answered here: navigation is observed, not completed.
    const requested = page.waitForRequest((r) => new URL(r.url()).pathname === "/director/attention");
    const closedAtOnce = await drawer(page)
      .getByRole("link", { name: /Attention/ })
      .evaluate(
        (link: HTMLElement) =>
          new Promise<boolean>((resolve) => {
            const dialog = link.closest("dialog")!;
            new MutationObserver((_, observer) => {
              observer.disconnect();
              resolve(!dialog.open && dialog.inert);
            }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
            link.click();
          })
      );
    expect(closedAtOnce).toBe(true);
    await requested;
  });

  test("a route change while it is open closes it, with the shell still mounted, and leaves the page usable", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();

    // The pathname changes under the mounted shell, as when the browser's
    // Back or Forward buttons move between portal pages (Next.js syncs
    // history.pushState into usePathname). The harness page stays rendered.
    await page.evaluate(() => window.history.pushState(null, "", "/dev/shell/elsewhere"));
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 1"); // same page instance: state kept
    const background = page.getByRole("button", { name: "Background action" });
    await background.focus();
    await expect(background).toBeFocused();
    await background.click();
    await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 2");
  });

  test("widening to the desktop layout closes the open drawer, so the page is never left inert", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(sidebar(page)).toBeVisible();
    await page.getByRole("button", { name: "Background action" }).click();
    await expect(page.getByTestId("shell-log")).toHaveText("Background clicks: 2");
  });

  test("motion-drawer: enters in 300ms ease-emphasized, exits in 200ms ease-in-out, animating only transform (and the backdrop's opacity)", async ({ page }) => {
    await openShell(page);
    const entering = await clickAndReadTransitions(menuButton(page));
    expect(entering.open).toBe(true);
    const props = (list: typeof entering.transitions, pseudo: string) => list.filter((t) => t.pseudo === pseudo).map((t) => t.property);
    expect(props(entering.transitions, "")).toContain("transform");
    for (const p of props(entering.transitions, "")) expect(["transform", "display", "overlay"]).toContain(p);
    expect(props(entering.transitions, "::backdrop")).toContain("opacity");
    for (const t of entering.transitions) expect(t.ms).toBe(300);

    const d = drawer(page);
    // Let the enter finish: closing mid-enter would reverse it, which the browser shortens.
    await expect.poll(() => d.evaluate((el) => el.getAnimations().length)).toBe(0);
    const open = await d.evaluate((el) => ({ property: getComputedStyle(el).transitionProperty, easing: getComputedStyle(el).transitionTimingFunction, animation: getComputedStyle(el).animationName }));
    expect(open).toEqual({ property: "transform, display, overlay", easing: EASE_EMPHASIZED, animation: "none" });

    const exiting = await clickAndReadTransitions(d.getByRole("button", { name: "Close menu" }));
    expect(exiting.open).toBe(false);
    expect(props(exiting.transitions, "").sort()).toEqual(["display", "overlay", "transform"]);
    expect(props(exiting.transitions, "::backdrop")).toEqual(["opacity"]);
    for (const t of exiting.transitions) expect(t.ms).toBe(200);
    // Read at close, while the dialog is certainly connected (see clickAndReadTransitions).
    expect(exiting.connected).toBe(true);
    expect(exiting.easing).toBe(EASE_IN_OUT);
    // It stays in the page for its whole exit, and is removed after it.
    expect(exiting.connectedWhenExitFinished).toBe(true);
    await expect(page.locator("dialog")).toHaveCount(0);
  });

  test("axe: no violations with the drawer open", async ({ page }) => {
    await openShell(page);
    await menuButton(page).click();
    await expect.poll(() => drawer(page).evaluate((el) => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});

test.describe("mobile drawer with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });
  test.beforeEach(async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 768, height: 800 });
  });

  test("appears at once, stays usable, closes on Escape and returns focus", async ({ page }) => {
    await openShell(page);
    await menuButton(page).focus();
    await page.keyboard.press("Enter");
    const d = drawer(page);
    await expect(d).toBeVisible();
    for (const pseudo of [undefined, "::backdrop"]) {
      const durations = await d.evaluate((el, p) => getComputedStyle(el, p ?? null).transitionDuration, pseudo);
      for (const ms of durations.split(",").map(toMs)) expect(ms).toBeLessThanOrEqual(0.01);
    }
    expect(await d.evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(0);
    expect(await focusPosition(page)).toBe("drawer:Close menu");
    await page.keyboard.press("Tab");
    expect(await focusPosition(page)).toBe("drawer:Dashboard");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
  });
});
