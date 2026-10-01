import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Checkpoint 4, M4: the Modal on a native <dialog>, verified on the
// development gallery's harness (app/dev/gallery/demos.tsx →
// ModalBehaviourDemos), which is shaped like the portal's own callers: the
// browser's modal top layer, focus moved in and returned, Escape and the
// backdrop asking the caller to close, the page behind inert, the
// motion-dialog contract, and the same with reduced motion requested.

const EASE_IN_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";
const EASE_EMPHASIZED = "cubic-bezier(0.2, 0, 0, 1)";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

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

async function openGallery(page: Page) {
  await page.goto("/dev/gallery");
  // Hydrated: the async-resource demo only reaches "success" from a client effect.
  await expect(page.getByTestId("resource-status")).toHaveText("success");
  await page.getByTestId("gallery-modal-behaviour").scrollIntoViewIfNeeded();
}

const log = (page: Page) => page.getByTestId("modal-log");
const trigger = (page: Page) => page.getByRole("button", { name: "Edit Asha Rao" });
const editDialog = (page: Page) => page.getByRole("dialog", { name: "Edit Asha Rao" });
/** The same dialog found by its content: also while it is closed and playing its exit. */
const editDialogElement = (page: Page) => page.locator("dialog", { hasText: "Edit Asha Rao" });

/** Where focus is: "dialog:<label>" inside the open dialog, "document" when on no element, else "page:<label>". */
async function focusPosition(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "document";
    const label = a.getAttribute("aria-label") || a.id || a.textContent?.trim().slice(0, 24) || a.tagName;
    return `${a.closest("dialog[open]") ? "dialog" : "page"}:${label}`;
  });
}

/** Clicks `button` and, when a dialog's `open` attribute next changes, lists the CSS transitions that started on that dialog and its ::backdrop. */
async function clickAndReadTransitions(button: Locator) {
  return button.evaluate(
    (el: HTMLElement) =>
      new Promise<{
        open: boolean;
        connected: boolean;
        style: { property: string; duration: string; easing: string };
        backdropStyle: { property: string; duration: string; easing: string };
        transitions: { property: string; pseudo: string; ms: number }[];
      }>((resolve) => {
        const observer = new MutationObserver((records) => {
          const dialog = records.map((r) => r.target).find((t): t is HTMLDialogElement => t instanceof HTMLDialogElement);
          if (!dialog) return;
          observer.disconnect();
          const transitions = document
            .getAnimations()
            .filter((a) => a instanceof CSSTransition && (a.effect as KeyframeEffect | null)?.target === dialog)
            .map((a) => {
              const effect = a.effect as KeyframeEffect;
              return { property: (a as CSSTransition).transitionProperty, pseudo: effect.pseudoElement ?? "", ms: Number(effect.getTiming().duration) };
            });
          const readStyle = (pseudo?: string) => {
            const style = getComputedStyle(dialog, pseudo ?? null);
            return {
              property: style.transitionProperty,
              duration: style.transitionDuration,
              easing: style.transitionTimingFunction,
            };
          };
          resolve({
            open: dialog.open,
            connected: dialog.isConnected,
            style: readStyle(),
            backdropStyle: readStyle("::backdrop"),
            transitions,
          });
        });
        observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
        el.click();
      })
  );
}

async function computedTransition(dialog: Locator, pseudo?: string) {
  return dialog.evaluate((el, p) => {
    const s = getComputedStyle(el, p ?? null);
    return { property: s.transitionProperty, duration: s.transitionDuration, easing: s.transitionTimingFunction };
  }, pseudo);
}

test.describe("Modal: native dialog lifecycle", () => {
  test("opens with the mouse as a native modal dialog, and focus moves inside onto the Close button", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    const dialog = editDialog(page);
    await expect(dialog).toBeVisible();

    const state = await dialog.evaluate((d: HTMLDialogElement) => ({
      tag: d.tagName,
      open: d.open,
      modal: d.matches(":modal"),
      inert: d.inert,
      role: d.getAttribute("role"),
      ariaModal: d.getAttribute("aria-modal"),
      zIndex: getComputedStyle(d).zIndex,
      position: getComputedStyle(d).position,
    }));
    expect(state).toEqual({ tag: "DIALOG", open: true, modal: true, inert: false, role: null, ariaModal: null, zIndex: "auto", position: "fixed" });
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  });

  test("opens with the keyboard — Enter and Space — and focus moves inside", async ({ page }) => {
    await openGallery(page);
    for (const key of ["Enter", "Space"]) {
      await trigger(page).focus();
      await page.keyboard.press(key);
      await expect(editDialog(page)).toBeVisible();
      expect(await focusPosition(page)).toBe("dialog:Close");
      await page.keyboard.press("Escape");
      await expect(editDialogElement(page)).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
    }
  });

  test("Escape asks the caller to close once, and focus returns to the trigger", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    await expect(editDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editDialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(log(page)).toContainText("Close requests: 1 ");
    await expect(editDialogElement(page)).toHaveCount(0);
    await expect(page.locator("dialog[open]")).toHaveCount(0); // no stale open attribute
  });

  test("the Close button closes, once, and focus returns to the trigger", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    await editDialog(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(editDialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(log(page)).toContainText("Close requests: 1 ");
  });

  test("a close driven by the caller (Save) needs no onClose, keeps the values, and returns focus", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    const dialog = editDialog(page);
    await dialog.getByLabel("Programme").selectOption("B.Tech ECE");
    await dialog.getByLabel("Note").fill("Branch change approved");
    // No <form> in this dialog, as in every portal caller: Enter submits nothing and closes nothing.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(log(page)).toContainText("Saved: none");

    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(log(page)).toContainText("Close requests: 0 · Saved: Asha Rao: B.Tech ECE / Branch change approved");
    await expect(trigger(page)).toBeFocused();
  });

  test("while it closes, the content stays as it was and cannot be used; then it is unmounted", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    await expect(editDialog(page)).toBeVisible();

    // Cancel clears the record behind the content in the same update.
    const closing = await editDialog(page)
      .getByRole("button", { name: "Cancel" })
      .evaluate(
        (button: HTMLElement) =>
          new Promise<{ open: boolean; inert: boolean; title: string | null; fields: number; exiting: boolean }>((resolve) => {
            const dialog = button.closest("dialog")!;
            new MutationObserver((_, observer) => {
              observer.disconnect();
              resolve({
                open: dialog.open,
                inert: dialog.inert,
                title: dialog.querySelector("h2")?.textContent ?? null,
                fields: dialog.querySelectorAll("select, input").length,
                exiting: getComputedStyle(dialog).display !== "none",
              });
            }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
            button.click();
          })
      );
    expect(closing).toEqual({ open: false, inert: true, title: "Edit Asha Rao", fields: 2, exiting: true });
    await expect(editDialogElement(page)).toHaveCount(0);
  });

  test("rapid open → close → open, and open → Escape, leave React and the dialog in step", async ({ page }) => {
    await openGallery(page);
    const result = await page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
      const dialog = () => [...document.querySelectorAll("dialog")].find((d) => d.textContent?.includes("Edit Asha Rao"));
      const opener = byText("Edit Asha Rao");
      opener.focus();
      opener.click(); // open
      await frame();
      const opened = dialog()?.open;
      dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); // close during the enter
      await frame();
      const closed = { open: dialog()?.open, inert: dialog()?.inert };
      opener.click(); // reopen during the exit
      await frame();
      const d = dialog()!;
      return {
        opened,
        closed,
        reopened: { open: d.open, modal: d.matches(":modal"), inert: d.inert, focusInside: d.contains(document.activeElement) },
        dialogsOpen: document.querySelectorAll("dialog[open]").length,
        dialogsForRecord: document.querySelectorAll("dialog").length - 2, // minus the two bare M1 utility demos
      };
    });
    expect(result).toEqual({
      opened: true,
      closed: { open: false, inert: true },
      reopened: { open: true, modal: true, inert: false, focusInside: true },
      dialogsOpen: 1,
      dialogsForRecord: 1,
    });

    // Escape straight after opening, before the enter has finished.
    await page.keyboard.press("Escape");
    await trigger(page).click();
    await page.keyboard.press("Escape");
    await expect(editDialogElement(page)).toHaveCount(0);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(log(page)).toContainText("Close requests: 3 ");
  });
});

test.describe("Modal: focus containment and the inert page", () => {
  const FOCUSABLES = ["dialog:Close", "dialog:g-edit-programme", "dialog:g-edit-note", "dialog:Cancel", "dialog:Save"];

  for (const key of ["Tab", "Shift+Tab"]) {
    test(`${key} cycles through the dialog's controls and never reaches the page`, async ({ page }) => {
      await openGallery(page);
      await trigger(page).focus();
      await page.keyboard.press("Enter");
      await expect(editDialog(page)).toBeVisible();

      const stops: string[] = [];
      for (let i = 0; i < 2 * (FOCUSABLES.length + 1); i++) {
        await page.keyboard.press(key);
        stops.push(await focusPosition(page));
      }
      // Two full cycles. The one stop outside the dialog is the browser's
      // own (focus leaves the document for the browser UI): no page element.
      expect(stops.filter((s) => s.startsWith("page:"))).toEqual([]);
      expect(stops.filter((s) => s === "document")).toHaveLength(2);
      const order = key === "Tab" ? FOCUSABLES : [...FOCUSABLES].reverse();
      const inDialog = stops.filter((s) => s !== "document");
      expect(new Set(inDialog)).toEqual(new Set(FOCUSABLES));
      // In order, wrapping around.
      const start = order.indexOf(inDialog[0]);
      inDialog.forEach((stop, i) => expect(stop).toBe(order[(start + i) % order.length]));
    });
  }

  test("the page behind is inert: hidden from assistive technology, unfocusable, and a backdrop click never reaches it", async ({ page }) => {
    await openGallery(page);
    const background = page.locator("button", { hasText: "Background action" });
    // Chromium's own accessibility tree (Playwright's role queries do not model modal inertness).
    const cdp = await page.context().newCDPSession(page);
    const exposed = async () => {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      return nodes.some((n) => n.name?.value === "Background action" && !n.ignored);
    };
    expect(await exposed()).toBe(true);
    // A point in the 16px gutter, over real page content before the dialog opens.
    const point = { x: 8, y: 8 };
    const hitStack = () => page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).map((e) => e.tagName), point);
    expect((await hitStack()).some((tag) => !["HTML", "BODY"].includes(tag))).toBe(true);
    await trigger(page).click();
    await expect(editDialog(page)).toBeVisible();

    expect(await exposed()).toBe(false);
    expect(await background.evaluate((el: HTMLElement) => (el.focus(), document.activeElement === el))).toBe(false);

    // Now the ::backdrop (hit-tested as the dialog) is on top, and the inert page is not hit-testable at all.
    const stack = await hitStack();
    expect(stack[0]).toBe("DIALOG");
    expect(stack.filter((tag) => !["DIALOG", "HTML", "BODY"].includes(tag))).toEqual([]);
    await page.evaluate(() => {
      const w = window as unknown as { leaked: string[] };
      w.leaked = [];
      document.addEventListener("click", (e) => { if (!(e.target as Element).closest("dialog")) w.leaked.push((e.target as Element).tagName); }, true);
    });

    await page.mouse.click(point.x, point.y);
    await expect(editDialog(page)).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { leaked: string[] }).leaked)).toEqual([]);
    await expect(log(page)).toContainText("Background clicks: 0 · Close requests: 1 ");
    await expect(trigger(page)).toBeFocused();
  });

  test("a press inside the dialog released over the backdrop (a text selection) does not dismiss it", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    const dialog = editDialog(page);
    await expect(dialog).toBeVisible();
    const title = await dialog.getByRole("heading", { name: "Edit Asha Rao" }).boundingBox();
    await page.mouse.move(title!.x + 4, title!.y + title!.height / 2);
    await page.mouse.down();
    await page.mouse.move(4, 4, { steps: 4 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await expect(log(page)).toContainText("Close requests: 0 ");
  });

  test("focus falls back safely when the trigger is removed, and Tab continues from where it was", async ({ page }) => {
    await openGallery(page);
    await page.getByRole("button", { name: "Delete draft" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete draft?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Delete draft" })).toHaveCount(0);

    expect(await focusPosition(page)).toBe("document");
    await page.keyboard.press("Tab");
    const next = await focusPosition(page);
    expect(next.startsWith("page:")).toBe(true);
    await page.getByRole("button", { name: "Restore draft" }).click();
    await expect(page.getByRole("button", { name: "Delete draft" })).toBeVisible();
  });

  test("focus falls back safely when the trigger is disabled while the dialog is open", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    await expect(editDialog(page)).toBeVisible();
    await page.locator("button", { hasText: "Edit Asha Rao" }).evaluate((el: HTMLButtonElement) => (el.disabled = true));
    await page.keyboard.press("Escape");
    await expect(editDialogElement(page)).toHaveCount(0);
    expect(await focusPosition(page)).toBe("document");
  });
});

test.describe("Modal: semantics", () => {
  test("named by its title, described by its description, with a named Close button", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    const dialog = editDialog(page);
    await expect(dialog).toHaveAccessibleName("Edit Asha Rao");
    await expect(dialog).toHaveAccessibleDescription("22CS041");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveAttribute("type", "button");
    // One close control and one heading: the old fake backdrop button is gone.
    await expect(dialog.getByRole("button", { name: /close/i })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Close dialog" })).toHaveCount(0);
    await expect(dialog.getByRole("heading")).toHaveCount(1);
  });

  test("a dialog without a description has no aria-describedby", async ({ page }) => {
    await openGallery(page);
    await page.getByRole("button", { name: "Open long modal" }).click();
    const dialog = page.getByRole("dialog", { name: "Attendance regulations" });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("aria-describedby");
  });

  test("axe: no violations with the dialog open", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    await expect(editDialog(page)).toBeVisible();
    await expect.poll(() => editDialog(page).evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).include("dialog[open]").analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});

test.describe("Modal: motion-dialog", () => {
  const PROPS = ["opacity", "transform", "display", "overlay"];

  test("enters in 200ms ease-emphasized and exits in 150ms ease-in-out, animating only opacity, transform, display and overlay", async ({ page }) => {
    await openGallery(page);
    const entering = await clickAndReadTransitions(trigger(page));
    expect(entering.open).toBe(true);
    // Mounted and opened in one commit, the dialog has no earlier rendered
    // style for display/overlay to leave: its enter is opacity and transform
    // (display and overlay matter on exit, keeping it rendered while it fades).
    const enter = (pseudo: string) => entering.transitions.filter((t) => t.pseudo === pseudo).map((t) => t.property).sort();
    expect(enter("")).toEqual(expect.arrayContaining(["opacity", "transform"]));
    for (const p of enter("")) expect(PROPS).toContain(p);
    expect(enter("::backdrop")).toContain("opacity");
    for (const p of enter("::backdrop")) expect(["opacity", "display", "overlay"]).toContain(p);
    for (const t of entering.transitions) expect(t.ms).toBe(200);

    const dialog = editDialog(page);
    const open = await computedTransition(dialog);
    expect(open.property.split(", ")).toEqual(PROPS);
    expect(open.easing).toBe(EASE_EMPHASIZED);
    expect((await computedTransition(dialog, "::backdrop")).easing).toBe(EASE_EMPHASIZED);
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    const exiting = await clickAndReadTransitions(dialog.getByRole("button", { name: "Close", exact: true }));
    expect(exiting.open).toBe(false);
    expect(exiting.connected).toBe(true);
    expect(exiting.transitions.filter((t) => t.pseudo === "").map((t) => t.property).sort()).toEqual([...PROPS].sort());
    // The ::backdrop lives as long as the dialog stays in the top layer: it only fades.
    expect(exiting.transitions.filter((t) => t.pseudo === "::backdrop").map((t) => t.property)).toEqual(["opacity"]);
    for (const t of exiting.transitions) expect(t.ms).toBe(150);
    expect(exiting.style.property.split(", ")).toEqual(PROPS);
    expect(toMs(exiting.style.duration)).toBe(150);
    expect(exiting.style.easing).toBe(EASE_IN_OUT);
    expect(toMs(exiting.backdropStyle.duration)).toBe(150);
    expect(exiting.backdropStyle.easing).toBe(EASE_IN_OUT);
    await expect(editDialogElement(page)).toHaveCount(0);
  });

  test("no keyframe animation, no shadow or layout transition, and the backdrop is the native ::backdrop", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    const dialog = editDialog(page);
    await expect(dialog).toBeVisible();
    const style = await dialog.evaluate((d) => {
      const s = getComputedStyle(d);
      const b = getComputedStyle(d, "::backdrop");
      return {
        animation: s.animationName,
        backdropAnimation: b.animationName,
        backdropBackground: b.backgroundColor,
        backdropFilter: b.backdropFilter,
        backdropTransition: b.transitionProperty,
        siblings: [...d.parentElement!.children].filter((c) => c !== d && getComputedStyle(c).position === "fixed").length,
      };
    });
    expect(style).toEqual({
      animation: "none",
      backdropAnimation: "none",
      backdropBackground: expect.stringMatching(/^(oklab|color-mix|rgba)\(/),
      backdropFilter: expect.stringContaining("blur("),
      backdropTransition: "opacity, display, overlay",
      siblings: 0,
    });
    for (const property of (await computedTransition(dialog)).property.split(", ")) {
      expect(["opacity", "transform", "display", "overlay"]).toContain(property);
    }
  });
});

test.describe("Modal: layout", () => {
  test("keeps a 16px gutter, is centred, and fits the viewport", async ({ page }) => {
    await openGallery(page);
    await trigger(page).click();
    const dialog = editDialog(page);
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    const { box, vw, vh } = await dialog.evaluate((d) => ({ box: d.getBoundingClientRect().toJSON() as DOMRect, vw: document.documentElement.clientWidth, vh: window.innerHeight }));
    const width = Math.min(512, vw - 32);
    expect(Math.round(box.width)).toBe(width);
    expect(Math.round(box.x)).toBe(Math.round((vw - width) / 2));
    expect(box.y).toBeGreaterThanOrEqual(16);
    expect(box.y + box.height).toBeLessThanOrEqual(vh - 16);
    // Every control is usable.
    await dialog.getByLabel("Note").fill("ok");
    await expect(dialog.getByLabel("Note")).toHaveValue("ok");
  });

  test("long content scrolls inside the dialog while the page behind stays put", async ({ page }) => {
    await openGallery(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.getByRole("button", { name: "Open long modal" }).click();
    const dialog = page.getByRole("dialog", { name: "Attendance regulations" });
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    const body = page.getByTestId("long-modal-content").locator("..");
    const metrics = await body.evaluate((el) => ({ scrollable: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflowY }));
    expect(metrics).toEqual({ scrollable: true, overflow: "auto" });
    const box = await dialog.boundingBox();
    const vh = await page.evaluate(() => window.innerHeight);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh);

    const content = await body.boundingBox();
    await page.mouse.move(content!.x + content!.width / 2, content!.y + content!.height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });
});

test.describe("Modal: a form inside", () => {
  test("validation applies, Enter submits once and closes, Cancel never submits", async ({ page }) => {
    await openGallery(page);
    const opener = page.getByRole("button", { name: "Open form modal" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "New circular" });
    const title = dialog.getByLabel("Circular title");

    // Required and empty: Enter does not submit.
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(log(page)).toContainText("Submissions: 0");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(log(page)).toContainText("Submissions: 0");
    await expect(opener).toBeFocused();

    await opener.click();
    await title.fill("Mid-semester timetable");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(log(page)).toContainText("Submissions: 1");
    await expect(opener).toBeFocused();

    // The footer's submit button, associated through form="…".
    await opener.click();
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(dialog).toBeHidden();
    await expect(log(page)).toContainText("Submissions: 2");
  });
});

test.describe("Modal: with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  test("opens fully at once, stays usable, closes on Escape, returns focus, and unmounts", async ({ page }) => {
    await openGallery(page);
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    const dialog = editDialog(page);
    await expect(dialog).toBeVisible();
    for (const pseudo of [undefined, "::backdrop"]) {
      for (const ms of (await computedTransition(dialog, pseudo)).duration.split(",").map(toMs)) expect(ms).toBeLessThanOrEqual(0.01);
    }
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    expect(await focusPosition(page)).toBe("dialog:Close");
    await page.keyboard.press("Tab");
    expect(await focusPosition(page)).toBe("dialog:g-edit-programme");

    await page.keyboard.press("Escape");
    await expect(editDialogElement(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(log(page)).toContainText("Close requests: 1 ");
  });
});
