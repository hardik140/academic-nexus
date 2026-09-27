import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Automated WCAG 2.2 AA scan (axe-core) of the pages reachable without data.
 *
 * The current UI does NOT pass. Rather than hide that, the known failures are
 * listed here by rule, with the most elements each may affect on each page
 * (the worst case across the configured viewports, measured when this test
 * was written). The test fails on any NEW rule, and on any known rule
 * spreading to more elements. When a foundation stage fixes one, lower its
 * ceiling or delete the entry — never raise a ceiling to make a run pass.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type KnownDebt = { maxNodes: number; reason: string };

// color-contrast was removed from both pages by Foundation Stage 2 (was 2 on
// /login, 22 on /dev/gallery): any contrast failure is now a new violation.
const KNOWN_DEBT: Record<string, Record<string, KnownDebt>> = {
  "/login": {},
  "/dev/gallery": {
    "scrollable-region-focusable": {
      maxNodes: 3,
      reason: "DataTable's overflow-x container cannot receive keyboard focus when it scrolls (375px). Fixed by the DataTable refactor.",
    },
  },
};

for (const [path, debt] of Object.entries(KNOWN_DEBT)) {
  test(`axe WCAG 2.2 AA scan of ${path} has no violations beyond documented debt`, async ({ page }, testInfo) => {
    await page.goto(path);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    await testInfo.attach("axe-violations.json", {
      body: JSON.stringify(violations, null, 2),
      contentType: "application/json",
    });

    const found = Object.fromEntries(violations.map((v) => [v.id, v.nodes.length]));

    const unexpected = Object.keys(found).filter((id) => !(id in debt));
    expect(unexpected, `new axe violations on ${path}`).toEqual([]);

    for (const [id, count] of Object.entries(found)) {
      expect(count, `${id} on ${path}: ${debt[id].reason}`).toBeLessThanOrEqual(debt[id].maxNodes);
    }
  });
}
