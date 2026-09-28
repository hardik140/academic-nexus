import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// M6.2–M6.8 in a browser, on the development gallery's demos (owner decision
// D3 keeps portal pages out of reach) and the login page: the toast, the
// confirmation dialog, request-decision, field validation, DataTable's
// failed-load states, session expiry with same-tab recovery through
// /login?next=, and the not-found page. Nothing reaches a remote service:
// the isolated server points Supabase at a closed local port, and the few
// Supabase Auth calls a test needs are answered here.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SUPABASE = "http://127.0.0.1:9"; // NEXT_PUBLIC_SUPABASE_URL in playwright.config.ts

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

async function openGallery(page: Page, section: string) {
  await page.goto("/dev/gallery");
  // Hydrated: the async-resource demo only reaches "success" from a client effect.
  await expect(page.getByTestId("resource-status")).toHaveText("success");
  await page.getByTestId(`gallery-${section}`).scrollIntoViewIfNeeded();
}

/**
 * Scans the section under test. The whole gallery page is scanned by
 * e2e/a11y.spec.ts, which holds its documented debt to a fixed ceiling.
 */
async function expectNoAxeViolations(page: Page, section?: string) {
  const builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  const results = await (section ? builder.include(`[data-testid="gallery-${section}"]`) : builder).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

// ─── Toast ───────────────────────────────────────────────────────────────

const toastDemo = (page: Page) => page.getByTestId("toast-demo");
const toastList = (page: Page) => page.getByRole("region", { name: "Notifications" }).locator("ol");
const toasts = (page: Page) => toastList(page).locator("li");
const raise = (page: Page, name: string) => toastDemo(page).getByRole("button", { name }).click();

test.describe("Toast", () => {
  test("announced politely through a live region that existed first; never role=alert; focus stays on the trigger", async ({ page }) => {
    await openGallery(page, "toast");
    const list = toastList(page);
    await expect(list).toHaveAttribute("aria-live", "polite");
    await expect(list).toHaveAttribute("aria-atomic", "false");
    await expect(list).toHaveAttribute("aria-relevant", "additions");
    await expect(toasts(page)).toHaveCount(0);

    const trigger = toastDemo(page).getByRole("button", { name: "Show success toast" });
    await trigger.click();
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page)).toHaveText(/Success: Invitation resent to asha@example\.edu\./);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("region", { name: "Notifications" }).locator('[role="alert"],[role="alertdialog"]')).toHaveCount(0);
    await expectNoAxeViolations(page, "toast");
  });

  test("the same message, or the same id, is shown once", async ({ page }) => {
    await openGallery(page, "toast");
    await raise(page, "Show success toast");
    await raise(page, "Show success toast");
    await raise(page, "Show toast with id");
    await raise(page, "Show toast with id");
    await expect(toasts(page)).toHaveCount(2);
  });

  test("at most three at once; dismissing one brings in the next, and focus stays in the list", async ({ page }) => {
    await openGallery(page, "toast");
    await raise(page, "Show four toasts");
    await expect(toasts(page)).toHaveCount(3);
    await expect(toastList(page)).not.toContainText("Sample notice 4.");

    const first = toasts(page).first().getByRole("button", { name: "Dismiss notification" });
    await first.focus();
    await page.keyboard.press("Escape");
    await expect(toasts(page)).toHaveCount(3);
    await expect(toastList(page)).toContainText("Sample notice 4.");
    expect(await page.evaluate(() => document.activeElement?.closest("section")?.getAttribute("aria-label"))).toBe("Notifications");

    await page.keyboard.press("Enter");
    await expect(toasts(page)).toHaveCount(2);
  });

  test("stays at least six seconds, then leaves on its own", async ({ page }) => {
    test.setTimeout(45_000);
    await openGallery(page, "toast");
    await raise(page, "Show info toast");
    await page.waitForTimeout(5500);
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page)).toHaveCount(0, { timeout: 3000 });
  });

  test("the pointer over it, or focus in it, holds it", async ({ page }) => {
    test.setTimeout(60_000); // real time: two 7s holds and a 6s run-out
    await openGallery(page, "toast");
    await raise(page, "Show info toast");
    await toasts(page).first().hover();
    await page.waitForTimeout(7000);
    await expect(toasts(page)).toHaveCount(1);

    await toasts(page).first().getByRole("button", { name: "Dismiss notification" }).focus();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(7000);
    await expect(toasts(page)).toHaveCount(1);

    // Released: it leaves within its time.
    await toastDemo(page).getByRole("button", { name: "Show success toast" }).focus();
    await expect(toasts(page)).toHaveCount(0, { timeout: 8000 });
  });

  test("a toast raised while a modal dialog is open is held, unrendered, until it closes", async ({ page }) => {
    await openGallery(page, "toast");
    const trigger = toastDemo(page).getByRole("button", { name: "Open dialog, toast after 0.5s" });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "A dialog over the page" })).toBeVisible();
    await page.waitForTimeout(1200);
    await expect(toasts(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(toasts(page)).toHaveCount(1);
    await expect(trigger).toBeFocused();
  });

  test("enters with motion-appear: 150ms of opacity", async ({ page }) => {
    await openGallery(page, "toast");
    await raise(page, "Show success toast");
    const style = await toasts(page).first().evaluate((el) => ({ property: getComputedStyle(el).transitionProperty, duration: getComputedStyle(el).transitionDuration }));
    expect(style.property).toBe("opacity");
    expect(toMs(style.duration)).toBe(150);
  });
});

test.describe("Toast with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("appears at once", async ({ page }) => {
    await openGallery(page, "toast");
    await raise(page, "Show success toast");
    const duration = await toasts(page).first().evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(toMs(duration)).toBeLessThanOrEqual(0.01);
    await expect(toasts(page).first()).toHaveCSS("opacity", "1");
  });
});

// ─── ConfirmationDialog ──────────────────────────────────────────────────

const confirmDemo = (page: Page) => page.getByTestId("confirm-demo");
const confirmDialog = (page: Page) => page.getByRole("dialog", { name: "Revoke this invitation?" });

test.describe("ConfirmationDialog", () => {
  test("opens with Cancel focused, is described, and Cancel returns focus to the trigger without acting", async ({ page }) => {
    await openGallery(page, "confirmation");
    const trigger = confirmDemo(page).getByRole("button", { name: "Revoke meera.iyer@example.edu" });
    await trigger.click();
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog).toHaveAccessibleDescription(/meera\.iyer@example\.edu will no longer be able to use the invitation link\./);
    await expectNoAxeViolations(page, "confirmation");

    await page.keyboard.press("Enter"); // Enter on the focused Cancel: never confirms
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId("confirm-calls")).toHaveText("Confirmations sent: 0");
  });

  test("while pending: one call however often Confirm is pressed, busy, and it cannot be cancelled", async ({ page }) => {
    await openGallery(page, "confirmation");
    await confirmDemo(page).getByRole("button", { name: "Revoke kabir.shah@example.edu" }).click();
    const dialog = confirmDialog(page);
    const confirm = dialog.getByRole("button", { name: "Revoke invitation" });
    await confirm.evaluate((el: HTMLButtonElement) => {
      el.click();
      el.click();
      el.click();
    });
    const pending = dialog.getByRole("button", { name: "Revoking…" });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    // Past the 150ms exit a close would run: still open, still working.
    await page.waitForTimeout(400);
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(pending).toBeVisible();
    await expect(page.getByTestId("confirm-calls")).toHaveText("Confirmations sent: 1");

    // Done: closed, the outcome stays on the page, the row goes, and focus —
    // whose opener has gone — lands on the outcome, not the document.
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const notice = confirmDemo(page).locator('[role="status"]').first();
    await expect(notice).toContainText("Invitation for kabir.shah@example.edu revoked.");
    await expect(confirmDemo(page).getByText("kabir.shah@example.edu", { exact: true })).toHaveCount(0);
    await expect(notice).toBeFocused();
    await expect(page.getByTestId("confirm-calls")).toHaveText("Confirmations sent: 1");
  });

  test("a failure stays in the dialog as an alert, and it can be tried again", async ({ page }) => {
    await openGallery(page, "confirmation");
    await confirmDemo(page).getByLabel("Next confirmation fails").check();
    await confirmDemo(page).getByRole("button", { name: "Revoke meera.iyer@example.edu" }).click();
    const dialog = confirmDialog(page);
    await dialog.getByRole("button", { name: "Revoke invitation" }).click();
    await expect(dialog.getByRole("alert")).toContainText("The invitation could not be revoked. Try again.");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Revoke invitation" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("confirm-calls")).toHaveText("Confirmations sent: 2");
  });
});

// ─── Request-decision ────────────────────────────────────────────────────

const decisionDemo = (page: Page) => page.getByTestId("request-decision-demo");
const decisionDialog = (page: Page) => page.getByRole("dialog", { name: "Request Director Decision" });

async function fillDecision(page: Page) {
  await decisionDemo(page).getByRole("button", { name: /Request Director Decision/ }).click();
  const dialog = decisionDialog(page);
  await dialog.getByLabel("Title").fill("Extend lab hours before practical exams");
  await dialog.getByLabel("Description").fill("Keep the CSE labs open until 21:00 for the two weeks before practicals.");
  return dialog;
}

test.describe("Request a Director decision", () => {
  test("sends once, however often Submit is pressed, and the outcome stays on the page", async ({ page }) => {
    await openGallery(page, "request-decision");
    const dialog = await fillDecision(page);
    await dialog.getByRole("button", { name: "Submit" }).evaluate((el: HTMLButtonElement) => {
      el.click();
      el.click();
    });
    await expect(dialog.getByRole("button", { name: "Sending…" })).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const status = decisionDemo(page).locator('[role="status"]');
    await expect(status).toContainText('Decision request "Extend lab hours before practical exams" sent to the Director.');
    await expect(page.getByTestId("request-decision-calls")).toHaveText("Requests sent: 1");
    // Persistent: still there well after any toast would have gone.
    await page.waitForTimeout(7000);
    await expect(status).toContainText("sent to the Director");
  });

  test("a network failure stays in the dialog, in plain words, with the form kept", async ({ page }) => {
    await openGallery(page, "request-decision");
    await decisionDemo(page).getByRole("combobox").selectOption("network");
    const dialog = await fillDecision(page);
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Couldn't reach the server. Check your internet connection, then try again.");
    await expect(dialog.getByRole("alert")).not.toContainText("Failed to fetch");
    await expect(dialog.getByLabel("Title")).toHaveValue("Extend lab hours before practical exams");
  });

  test("a Server Action failure with no session left says so, and offers Sign in again", async ({ page }) => {
    await openGallery(page, "request-decision");
    await decisionDemo(page).getByRole("combobox").selectOption("action");
    const dialog = await fillDecision(page);
    await dialog.getByRole("button", { name: "Submit" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("Your session has expired. Please sign in again.");
    await expect(alert).not.toContainText("Server Components render");
    await expect(alert.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login?next=%2Fdev%2Fgallery");
  });
});

// ─── Field validation ────────────────────────────────────────────────────

test.describe("Field validation", () => {
  test("invalid fields are marked, described by their message, summarised in an alert, and the first is focused", async ({ page }) => {
    await openGallery(page, "field-validation");
    const form = page.getByTestId("validation-demo");
    await form.getByRole("button", { name: "Save" }).click();
    const title = form.getByLabel("Title");
    const reason = form.getByLabel("Reason");
    await expect(form.getByRole("alert")).toContainText("Fill in the highlighted fields to continue.");
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(title).toHaveAccessibleDescription("Enter a title.");
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    await expect(reason).toHaveAccessibleDescription("Give a reason.");
    await expectNoAxeViolations(page, "field-validation");

    await title.fill("Guest lecture");
    await reason.fill("Industry session on cloud security for final-year students.");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(title).not.toHaveAttribute("aria-invalid");
    await expect(title).not.toHaveAttribute("aria-describedby");
    await expect(form.locator('[role="alert"] [data-tone]')).toHaveCount(0);
    await expect(form.locator('[role="status"]')).toContainText('"Guest lecture" saved.');
  });
});

// ─── DataTable: failed loads ─────────────────────────────────────────────

test.describe("DataTable failed loads", () => {
  test("a failed first load is an error with Try again — never the empty message — and Try again recovers", async ({ page }) => {
    await openGallery(page, "table-error");
    const demo = page.getByTestId("table-error-demo");
    await demo.getByRole("button", { name: "Table: fail first load" }).click();
    const failed = demo.locator("[data-error-state]");
    await expect(failed).toHaveAttribute("role", "alert");
    await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(demo.getByText("No students found.")).toHaveCount(0);
    await expect(demo.getByText("Sample failure")).toHaveCount(0);
    await expectNoAxeViolations(page, "table-error");
    await demo.getByRole("button", { name: "Try again" }).click();
    await expect(demo.getByRole("cell", { name: "Asha Rao" })).toBeVisible();
    await expect(demo.locator("[data-error-state]")).toHaveCount(0);
    await expect(demo.locator('[role="alert"] [data-tone]')).toHaveCount(0);
  });

  test("a failed refresh keeps the rows, beside an error that says so", async ({ page }) => {
    await openGallery(page, "table-error");
    const demo = page.getByTestId("table-error-demo");
    await demo.getByRole("button", { name: "Table: fail first load" }).click();
    await demo.getByRole("button", { name: "Try again" }).click();
    await expect(demo.getByRole("cell", { name: "Asha Rao" })).toBeVisible();
    await demo.getByRole("button", { name: "Table: fail a refresh" }).click();
    // Announced through the table's alert region, which was already there.
    await expect(demo.getByRole("alert")).toContainText("This couldn't be refreshed. Showing what was loaded earlier.");
    await expect(demo.getByRole("cell", { name: "Asha Rao" })).toBeVisible();
    await expect(demo.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});

// ─── Session expiry and same-tab recovery ────────────────────────────────

/** Answers Supabase Auth's password sign-in with a fictional session — no real project is involved. */
async function answerPasswordSignIn(page: Page) {
  await page.route(`${SUPABASE}/auth/v1/token?grant_type=password`, (route) => {
    const now = Math.floor(Date.now() / 1000);
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        access_token: "e2e-fictional-access-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: "e2e-fictional-refresh-token",
        user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "director@example.edu", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00.000Z" },
      }),
    });
  });
}

async function signIn(page: Page) {
  await page.getByLabel(/email/i).fill("director@example.edu");
  await page.getByLabel(/password/i).fill("fictional-password");
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

test.describe("Session expiry", () => {
  test("Sign in again stays in this tab, returns to the page after signing in, and is accessible", async ({ page, context }) => {
    await openGallery(page, "session");
    const demo = page.getByTestId("session-demo");
    // ErrorState (a failed load) and ErrorAlert (a failed action): both alerts.
    const alerts = demo.getByRole("alert");
    await expect(alerts).toHaveCount(2);
    for (const alert of await alerts.all()) await expect(alert).toContainText(/Your session has expired/);
    const links = demo.getByRole("link", { name: "Sign in again" });
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("href", "/login?next=%2Fdev%2Fgallery");
      await expect(link).not.toHaveAttribute("target");
    }
    await expectNoAxeViolations(page, "session");

    let opened = 0;
    context.on("page", () => opened++);
    await page.evaluate(() => history.replaceState(history.state, "", "/dev/gallery?tab=session"));
    await links.first().click();
    await expect(page).toHaveURL(/\/login\?next=%2Fdev%2Fgallery%3Ftab%3Dsession$/);
    expect(opened).toBe(0);
    await expect(page.getByRole("status").filter({ hasText: "Your session ended." })).toContainText("Sign in to return to the page you were on.");

    await answerPasswordSignIn(page);
    const back = page.waitForURL(/\/dev\/gallery\?tab=session$/);
    await signIn(page);
    await back;
  });

  test("an external or unsafe next is ignored: no notice, and sign-in goes home", async ({ page }) => {
    for (const next of ["https://evil.example/phish", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await expect(page.getByRole("heading", { name: "Sign in to your portal" })).toBeVisible();
      await expect(page.getByText("Your session ended.")).toHaveCount(0);
    }
    await answerPasswordSignIn(page);
    const home = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname === "/");
    await signIn(page);
    const request = await home;
    expect(new URL(request.url()).origin).toBe(new URL(page.url()).origin);
  });

  test("Google sign-in carries a safe next through /auth/callback", async ({ page }) => {
    await page.goto(`/login?next=${encodeURIComponent("/director/team")}`);
    await expect(page.getByText("Your session ended. Sign in to return to the page you were on.")).toBeVisible();
    let authorize: URL | null = null;
    await page.route(`${SUPABASE}/auth/v1/authorize**`, (route) => {
      authorize = new URL(route.request().url());
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stand-in</title>" });
    });
    await page.getByRole("button", { name: /google/i }).click();
    await expect.poll(() => authorize?.searchParams.get("redirect_to") ?? null).not.toBeNull();
    const redirectTo = new URL(authorize!.searchParams.get("redirect_to")!);
    expect(redirectTo.pathname).toBe("/auth/callback");
    expect(redirectTo.searchParams.get("next")).toBe("/director/team");
  });
});

// ─── Route-level pages ───────────────────────────────────────────────────

test("not-found: a heading, a way home, no raw detail, and axe passes", async ({ page }) => {
  const response = await page.goto("/dev/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page couldn't be found");
  await expect(page.getByRole("link", { name: /home|dashboard/i })).toBeVisible();
  await expectNoAxeViolations(page);
  // The one console error this page must produce: Chromium reports the
  // document's own 404 status. Anything else still fails the test.
  const messages = consoleMessages.get(page)!;
  const own404 = messages.indexOf("[error] Failed to load resource: the server responded with a status of 404 (Not Found)");
  expect(own404).toBeGreaterThanOrEqual(0);
  messages.splice(own404, 1);
});
