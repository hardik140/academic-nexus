import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Checkpoint 4, M7: every chart renders through ChartFigure. Verified on the
// development gallery's fictional data (the real chart pages sit behind
// login, owner decision D3):
//   - no chart animates, with or without a reduced-motion preference;
//   - each is a <figure> named by its caption, with the values in a table and
//     the drawing hidden from assistive technology, holding nothing focusable;
//   - the heatmap, already a table of text values, stays exposed;
//   - axe finds nothing.

const DRAWN = ["chart-donut", "chart-gauge", "chart-ratio", "funnel-chart"] as const;

// A chart's drawing: the SVG directly in Recharts' wrapper (legend icons are SVG surfaces too).
const SURFACE = ".recharts-wrapper > svg.recharts-surface";

/**
 * Waits, frame by frame, until every drawn chart has its SVG shapes, then
 * reads their geometry and text at once: the first frame they are drawn in.
 * Recharts animates by growing the shapes (and drawing a line's dots and
 * labels only when it has finished), so a chart that animates reads
 * differently here than once its animation would have ended.
 */
async function firstDrawnFrame(page: Page) {
  return page.evaluate(
    (ids) =>
      new Promise<Record<string, string[]>>((resolve) => {
        const read = (root: Element) => {
          const svg = root.querySelector(".recharts-wrapper > svg.recharts-surface");
          if (!svg) return null;
          const shapes = [...svg.querySelectorAll("path, circle, rect, text")]
            .filter((el) => !el.closest(".recharts-tooltip-wrapper"))
            .map((el) => [el.tagName, el.getAttribute("d"), el.getAttribute("cx"), el.getAttribute("cy"), el.getAttribute("width"), el.getAttribute("stroke-dasharray"), el.textContent].join("|"));
          return shapes.some((s) => s.startsWith("path|")) ? shapes : null;
        };
        const tick = () => {
          const frames = ids.map((id) => read(document.querySelector(`[data-testid="${id}"]`)!));
          if (frames.every(Boolean)) resolve(Object.fromEntries(ids.map((id, i) => [id, frames[i]!])));
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    [...DRAWN]
  );
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test.describe(`charts (${reducedMotion})`, () => {
    test.use({ reducedMotion });

    test("every chart is drawn complete in its first frame and never changes", async ({ page }) => {
      await page.goto("/dev/gallery");
      const first = await firstDrawnFrame(page);

      // The finished drawing is there from the start: the line's dots (drawn
      // only after a line animation) and the funnel's value labels.
      expect(first["chart-ratio"].filter((s) => s.startsWith("circle|")).length).toBeGreaterThanOrEqual(2);
      expect(first["funnel-chart"].filter((s) => s.startsWith("text|")).map((s) => s.split("|").at(-1))).toEqual(expect.arrayContaining(["Eligible", "420", "Placed", "58"]));

      await page.waitForTimeout(1_700); // longer than Recharts' 1.5 s default animation
      expect(await firstDrawnFrame(page)).toEqual(first);
    });
  });
}

/** The figure's table for screen readers, row by row. */
async function tableRows(figure: Locator) {
  return figure.getByRole("table").getByRole("row").evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent)));
}

/**
 * What the Tab key could reach inside the hidden drawing: should be nothing.
 * (Recharts gives its internal layers tabindex="-1": focusable from script
 * only, never in the tab order.)
 */
async function reachableInsideDrawing(figure: Locator) {
  const drawing = figure.locator(':scope > div[aria-hidden="true"]');
  await expect(drawing).toHaveCount(1);
  return drawing.evaluate((el) =>
    [...el.querySelectorAll("*")]
      .filter((n) => n.matches("[role=application], [tabindex]:not([tabindex^=\"-\"]), :is(a[href], button, input, select, textarea, [contenteditable]):not([tabindex^=\"-\"])"))
      .map((n) => n.outerHTML.slice(0, 80))
  );
}

test.describe("chart figures", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/gallery");
  });

  test("the donut is a figure named by its summary, with its slices in a table and the drawing hidden", async ({ page }) => {
    const figure = page.getByTestId("chart-donut").getByRole("figure", { name: "Hostel occupancy: 75% (Occupied 300, Vacant 100)." });
    await expect(figure).toBeVisible();
    expect(await tableRows(figure)).toEqual([["Segment", "Count"], ["Occupied", "300"], ["Vacant", "100"]]);
    await expect(figure.locator(SURFACE)).toBeVisible();
    expect(await reachableInsideDrawing(figure)).toEqual([]);
  });

  test("the gauge states its score and its caveat, with the drawing hidden", async ({ page }) => {
    const figure = page.getByTestId("chart-gauge").getByRole("figure", { name: "Institution Health: 68 out of 100, based on 3 of 4 signals." });
    await expect(figure).toBeVisible();
    await expect(figure.getByRole("table")).toHaveCount(0);
    await expect(figure.getByText("Based on 3 of 4 signals", { exact: true })).toBeVisible(); // still drawn for sighted users
    expect(await reachableInsideDrawing(figure)).toEqual([]);
  });

  test("the forecast ratio chart lists both ratios, with the drawing hidden", async ({ page }) => {
    const figure = page.getByTestId("chart-ratio").getByRole("figure", { name: "Faculty to student ratio: currently 1:18.5, projected 1:22." });
    await expect(figure).toBeVisible();
    expect(await tableRows(figure)).toEqual([["Scenario", "Faculty : Student"], ["Current", "1:18.5"], ["Projected", "1:22"]]);
    expect(await reachableInsideDrawing(figure)).toEqual([]);
  });

  test("the funnel lists every stage, with the drawing hidden", async ({ page }) => {
    const figure = page.getByTestId("funnel-chart").getByRole("figure", { name: "Placement funnel in 5 stages, from Eligible (420) to Placed (58)." });
    await expect(figure).toBeVisible();
    expect(await tableRows(figure)).toEqual([
      ["Stage", "Count"],
      ["Eligible", "420"],
      ["Applied", "310"],
      ["Shortlisted", "180"],
      ["Interviewed", "96"],
      ["Placed", "58"],
    ]);
    expect(await reachableInsideDrawing(figure)).toEqual([]);
  });

  test("the heatmap stays an exposed table, its links in the tab order, and its caption explains the bands", async ({ page }) => {
    const figure = page.getByTestId("chart-heatmap").getByRole("figure", { name: /^Department performance for 2 departments: .*Bands: 75% or more is good/ });
    await expect(figure).toBeVisible();
    await expect(figure.locator('[aria-hidden="true"]')).toHaveCount(0);
    const table = figure.getByRole("table");
    await expect(table).toHaveCount(1);
    await expect(table.getByRole("columnheader")).toHaveText(["Department", "Attendance", "Backlog", "Fee Collection", "Placement", "Open Risks"]);
    await expect(table.getByRole("link", { name: "Computer Science" })).toHaveAttribute("href", "/director/departments/performance/sample-cse");
    await table.getByRole("link", { name: "Computer Science" }).focus();
    await expect(table.getByRole("link", { name: "Computer Science" })).toBeFocused();
  });

  test("no Recharts surface is a focusable, unnamed application", async ({ page }) => {
    const surfaces = page.locator(SURFACE);
    await expect(surfaces).toHaveCount(DRAWN.length);
    for (const surface of await surfaces.all()) {
      expect(await surface.evaluate((svg) => [svg.getAttribute("role"), svg.getAttribute("tabindex")])).toEqual([null, null]);
    }
  });

  test("axe: no violations in the charts", async ({ page }) => {
    await expect(page.locator(SURFACE)).toHaveCount(DRAWN.length);
    const { violations } = await new AxeBuilder({ page })
      .include('[data-testid="gallery-funnel-chart"]')
      .include('[data-testid="gallery-chart-figures"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});
