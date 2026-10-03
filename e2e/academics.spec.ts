import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The academic foundation's screens (migration 055), verified on the
// development gallery's fictional data — the real pages read the database,
// which browser tests may not touch (owner decision D3). The database rules
// themselves are proven in tests/staging-academic-foundation.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function gallery(page: Page) {
  await page.goto("/dev/gallery");
  await expect(page.getByRole("heading", { level: 1, name: "Component gallery" })).toBeVisible();
}

async function noViolations(page: Page, section: string) {
  const { violations } = await new AxeBuilder({ page }).include(`[data-testid="gallery-${section}"]`).withTags(WCAG).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
}

test.describe("department term", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("a department that is not ready lists what blocks it, in words, and cannot start", async ({ page }) => {
    const panel = page.getByTestId("term-not-ready");
    await expect(panel).toContainText("Must be fixed before the term can start (2)");
    await expect(panel).toContainText("BTECH-CSE B (2024) has no Class In-Charge this term.");
    await expect(panel).toContainText("Blocking:");
    await expect(panel.getByRole("button", { name: "Start the department's term" })).toBeDisabled();
    await expect(panel).toContainText("Fix the items above to start the term.");
  });

  test("offerings without a teacher must be acknowledged before the start is offered, then confirmed", async ({ page }) => {
    const panel = page.getByTestId("term-pending");
    const start = panel.getByRole("button", { name: "Start the department's term" });
    await expect(start).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await expect(start).toBeEnabled();
    await start.click();
    const dialog = page.getByRole("dialog", { name: "Start Computer Science in Fall 2026?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Start term" }).click();
    await expect(page.getByTestId("academics-log")).toHaveText("start: acknowledged=true");
    await expect(dialog).toBeHidden();
  });

  test("ending needs a reason first, says what becomes read-only, then confirms", async ({ page }) => {
    const panel = page.getByTestId("term-running");
    const end = panel.getByRole("button", { name: "End the department's term" });
    await expect(end).toBeDisabled();
    await panel.getByLabel(/Reason for ending the term/).fill("Semester teaching complete");
    await expect(end).toBeEnabled();
    await end.click();
    const dialog = page.getByRole("dialog", { name: "End Computer Science's term?" });
    await expect(dialog).toContainText("read-only");
    await expect(dialog).toContainText("Everything already recorded is kept.");
    await dialog.getByRole("button", { name: "End term" }).click();
    await expect(page.getByTestId("academics-log")).toHaveText("end: Semester teaching complete");
  });

  test("a refusal from the database is shown, not swallowed", async ({ page }) => {
    await expect(page.getByTestId("term-error")).toContainText("Only the HOD of this department can end its term.");
  });

  test("axe: no violations", async ({ page }) => noViolations(page, "department-term"));
});

test.describe("Class In-Charge", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("an unassigned section says so; each section has its own labelled picker", async ({ page }) => {
    const table = page.getByTestId("class-incharge-table");
    await expect(table.getByRole("row", { name: /BTECH-CSE B \(2024\)/ })).toContainText("Not assigned");
    const picker = table.getByLabel("New Class In-Charge for BTECH-CSE B (2024)");
    const assign = table.getByRole("row", { name: /BTECH-CSE B \(2024\)/ }).getByRole("button", { name: "Assign" });
    await expect(assign).toBeDisabled();
    await picker.selectOption({ label: "Priya Nair" });
    await assign.click();
    await expect(page.getByTestId("incharge-log")).toHaveText("assign t2 to s2");
  });

  test("the current In-Charge is not offered as their own replacement", async ({ page }) => {
    const picker = page.getByTestId("class-incharge-table").getByLabel("New Class In-Charge for BTECH-CSE A (2024)");
    await expect(picker.locator("option", { hasText: "Rahul Sharma" })).toHaveCount(0);
  });

  test("axe: no violations", async ({ page }) => noViolations(page, "class-incharge"));
});

test.describe("student academic context", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("a placed student sees term, class, semester, section and In-Charge", async ({ page }) => {
    const card = page.getByTestId("context-placed");
    await expect(card.getByRole("heading", { name: "Your class" })).toBeVisible();
    for (const text of ["Fall 2026 · 2026-27", "B.Tech Computer Science", "Year 3", "A (2024 intake)", "Rahul Sharma"]) {
      await expect(card).toContainText(text);
    }
  });

  test("a student without a section is told so instead of being shown a guess", async ({ page }) => {
    const card = page.getByTestId("context-unplaced");
    await expect(card).toContainText("You have not been placed in a section yet.");
    await expect(card).not.toContainText("Class In-Charge");
  });

  test("axe: no violations", async ({ page }) => noViolations(page, "academic-context"));
});

test.describe("student invitation", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("the form has no department or batch-year field; the section decides them", async ({ page }) => {
    const form = page.getByTestId("invite-choose-section");
    await expect(form.getByLabel(/Department/)).toHaveCount(0);
    await expect(form.getByLabel(/Batch/)).toHaveCount(0);
    await expect(form).toContainText("The department, programme and intake year come from the section.");
  });

  test("an HOD chooses the section; nothing is sent until every required field is filled", async ({ page }) => {
    const form = page.getByTestId("invite-choose-section");
    const send = form.getByRole("button", { name: "Send invitation" });
    await expect(send).toBeDisabled();
    await form.getByLabel(/^Section/).selectOption({ label: "BTECH-CSE B (2024)" });
    await form.getByLabel(/^Full name/).fill("Asha Verma");
    await form.getByLabel(/^Email/).fill("asha@example.edu");
    await form.getByLabel(/^Enrollment number/).fill("2024CSE101");
    await form.getByLabel(/^Programme semester/).selectOption({ label: "Semester 5" });
    await send.click();
    await expect(page.getByTestId("invite-log")).toHaveText("invite asha@example.edu to s2, semester 5");
  });

  test("a Class In-Charge's form is fixed to their own section and shows a refusal", async ({ page }) => {
    const form = page.getByTestId("invite-fixed-section");
    await expect(form).toContainText("Section: BTECH-CSE A (2024)");
    await expect(form.getByLabel(/^Section/)).toHaveCount(0);
    await expect(form).toContainText("That enrollment number is already in use.");
  });

  test("axe: no violations", async ({ page }) => noViolations(page, "student-invite"));
});

test.describe("department timetable", () => {
  test.beforeEach(async ({ page }) => gallery(page));

  test("classes are grouped by day and say course, section, teacher, time and room", async ({ page }) => {
    const week = page.getByTestId("timetable-week").first();
    await expect(week.getByRole("heading", { name: "Monday" })).toBeVisible();
    await expect(week.getByRole("heading", { name: "Wednesday" })).toBeVisible();
    await expect(week).toContainText("09:00–10:00 · CS301 · BTECH-CSE A (2024)");
    await expect(week).toContainText("Rahul Sharma · Room R-101");
    await expect(week).toContainText("No teacher");
  });

  test("each Remove button names the class it removes", async ({ page }) => {
    await page.getByRole("button", { name: "Remove CS305 · BTECH-CSE A (2024) on Wednesday at 14:00" }).click();
    await expect(page.getByTestId("timetable-log")).toHaveText("remove sl3");
  });

  test("an empty week says so", async ({ page }) => {
    await expect(page.getByTestId("timetable-empty")).toContainText("No classes are scheduled yet for this term.");
  });

  test("axe: no violations", async ({ page }) => noViolations(page, "timetable-week"));
});
