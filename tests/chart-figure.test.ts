import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartFigure } from "@/components/charts/chart-figure";
import { DepartmentHeatmapGrid } from "@/components/charts/department-heatmap-grid";
import { DonutChart } from "@/components/charts/donut-chart";
import { FacultyRatioChart } from "@/components/charts/faculty-ratio-chart";
import { HealthGauge } from "@/components/charts/health-gauge";
import { PlacementFunnelChart } from "@/components/charts/placement-funnel-chart";

/**
 * Checkpoint 4, M7 — every chart is a <figure> named by a <figcaption>
 * summary, with the values as a table for screen readers and the drawing
 * hidden from assistive technology (the heatmap, already a table, stays
 * exposed). Rendered on the server: the figure, caption and table are in the
 * first HTML; the SVG itself is only drawn in the browser (e2e/charts.spec.ts).
 */

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

function caption(markup: string): string | null {
  return /<figcaption class="sr-only">([^<]*)<\/figcaption>/.exec(markup)?.[1] ?? null;
}

/** The screen-reader table's rows, header cells included, as text. */
function srTable(markup: string): string[][] {
  const table = /<table class="sr-only">([\s\S]*?)<\/table>/.exec(markup)?.[1];
  if (!table) return [];
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map((cell) => cell[1]));
}

describe("ChartFigure", () => {
  const render = (props: Partial<Omit<ComponentProps<typeof ChartFigure>, "children">>) =>
    // Children go in as createElement's third argument; the cast only satisfies its typing.
    html(createElement(ChartFigure, { caption: "Sample: 3 and 1.", ...props } as ComponentProps<typeof ChartFigure>, createElement("svg", { "data-drawing": "" })));

  it("is a figure named by its caption, with the drawing hidden and the values in a table", () => {
    const markup = render({ table: { columns: ["Segment", "Count"], rows: [["A", 3], ["B", 1]] } });
    expect(markup).toMatch(/^<figure><figcaption class="sr-only">Sample: 3 and 1\.<\/figcaption><div aria-hidden="true"><svg data-drawing=""><\/svg><\/div><table class="sr-only">/);
    expect(markup).toContain('<th scope="col">Segment</th><th scope="col">Count</th>');
    expect(markup).toContain('<tr><th scope="row">A</th><td>3</td></tr>');
    expect(srTable(markup)).toEqual([["Segment", "Count"], ["A", "3"], ["B", "1"]]);
  });

  it("without a table, the caption alone is the text alternative", () => {
    const markup = render({});
    expect(markup).not.toContain("<table");
    expect(markup).toContain('<div aria-hidden="true">');
  });

  it("an accessible visual is not hidden", () => {
    const markup = render({ accessibleVisual: true });
    expect(markup).not.toContain("aria-hidden");
    expect(markup).toContain("<div><svg");
  });
});

describe("DonutChart", () => {
  const slices = [
    { name: "Occupied", value: 300, color: "var(--color-secondary)" },
    { name: "Vacant", value: 100, color: "var(--color-outline-variant)" },
  ];

  it("summarises the title, centre label and every slice, and lists the slices", () => {
    const markup = html(createElement(DonutChart, { title: "Hostel occupancy", slices, centerLabel: "75%" }));
    expect(caption(markup)).toBe("Hostel occupancy: 75% (Occupied 300, Vacant 100).");
    expect(srTable(markup)).toEqual([["Segment", "Count"], ["Occupied", "300"], ["Vacant", "100"]]);
    expect(markup).toContain('<div aria-hidden="true">');
  });

  it("without a centre label, the caption still names every slice", () => {
    expect(caption(html(createElement(DonutChart, { title: "Hostel occupancy", slices })))).toBe("Hostel occupancy (Occupied 300, Vacant 100).");
  });

  it("with nothing to draw, the empty message is unchanged and there is no figure", () => {
    const markup = html(createElement(DonutChart, { title: "Hostel occupancy", slices: slices.map((s) => ({ ...s, value: 0 })) }));
    expect(markup).toContain("No data available yet.");
    expect(markup).not.toContain("<figure");
  });
});

describe("HealthGauge", () => {
  it("states the score out of 100", () => {
    const markup = html(createElement(HealthGauge, { score: 72 }));
    expect(caption(markup)).toBe("Institution Health: 72 out of 100.");
    expect(markup).toContain('<div aria-hidden="true">');
  });

  it("says when the score rests on only some of its signals", () => {
    const markup = html(createElement(HealthGauge, { score: 64, label: "Academic Health", contributingCount: 2, possibleCount: 3 }));
    expect(caption(markup)).toBe("Academic Health: 64 out of 100, based on 2 of 3 signals.");
    expect(markup).toContain(">Based on 2 of 3 signals<");
  });

  it("with every signal present, there is no caveat", () => {
    expect(caption(html(createElement(HealthGauge, { score: 80, contributingCount: 4, possibleCount: 4 })))).toBe("Institution Health: 80 out of 100.");
  });

  it("with no score, the insufficient-data message is unchanged and there is no figure", () => {
    const markup = html(createElement(HealthGauge, { score: null }));
    expect(markup).toContain("Insufficient data");
    expect(markup).not.toContain("<figure");
  });
});

describe("PlacementFunnelChart", () => {
  const stages = [
    { name: "Eligible", value: 420 },
    { name: "Applied", value: 310 },
    { name: "Shortlisted", value: 180 },
    { name: "Selected", value: 96 },
    { name: "Placed", value: 58 },
  ];

  it("summarises the funnel from first stage to last, and lists every stage", () => {
    const markup = html(createElement(PlacementFunnelChart, { stages }));
    expect(caption(markup)).toBe("Placement funnel in 5 stages, from Eligible (420) to Placed (58).");
    expect(srTable(markup)).toEqual([["Stage", "Count"], ...stages.map((s) => [s.name, String(s.value)])]);
  });

  it("a stage with no one in it is still listed", () => {
    const markup = html(createElement(PlacementFunnelChart, { stages: [...stages.slice(0, 4), { name: "Placed", value: 0 }] }));
    expect(srTable(markup).at(-1)).toEqual(["Placed", "0"]);
  });

  it("with no one in any stage, the empty message is unchanged and there is no figure", () => {
    const markup = html(createElement(PlacementFunnelChart, { stages: stages.map((s) => ({ ...s, value: 0 })) }));
    expect(markup).toContain("No placement funnel data available yet.");
    expect(markup).not.toContain("<figure");
  });
});

describe("FacultyRatioChart", () => {
  it("states both ratios and lists them", () => {
    const markup = html(createElement(FacultyRatioChart, { current: 18.5, projected: 22 }));
    expect(caption(markup)).toBe("Faculty to student ratio: currently 1:18.5, projected 1:22.");
    expect(srTable(markup)).toEqual([["Scenario", "Faculty : Student"], ["Current", "1:18.5"], ["Projected", "1:22"]]);
    expect(markup).toContain('<div aria-hidden="true">');
  });

  it("an unknown ratio reads as a dash, never as zero", () => {
    const markup = html(createElement(FacultyRatioChart, { current: 20, projected: null }));
    expect(caption(markup)).toBe("Faculty to student ratio: currently 1:20, projected —.");
    expect(srTable(markup).at(-1)).toEqual(["Projected", "—"]);
  });

  it("with neither ratio known, nothing is drawn", () => {
    expect(html(createElement(FacultyRatioChart, { current: null, projected: null }))).toBe("");
  });
});

describe("DepartmentHeatmapGrid", () => {
  const rows = [
    { departmentId: "d1", departmentName: "Computer Science", departmentCode: "CSE", attendancePct: 82, backlogRate: 12, feeCollectionPct: 64, placementRate: null, openRiskCount: 2 },
    { departmentId: "d2", departmentName: "Mechanical", departmentCode: "ME", attendancePct: 41, backlogRate: 55, feeCollectionPct: 90, placementRate: 71, openRiskCount: 0 },
  ];

  it("is a figure whose caption explains the bands; the grid itself stays exposed as the table", () => {
    const markup = html(createElement(DepartmentHeatmapGrid, { rows }));
    expect(caption(markup)).toBe(
      "Department performance for 2 departments: attendance, backlog, fee collection and placement percentages, and open risks. Bands: 75% or more is good, 50 to 74% needs attention, under 50% is poor; for backlog, lower is better."
    );
    expect(markup).not.toContain("aria-hidden");
    expect(markup).not.toContain('<table class="sr-only">');
    expect(markup).toContain('href="/director/departments/performance/d1"');
    expect(markup).toContain(">82%<");
    expect(markup).toContain(">—<");
  });

  it("colours its bands with the status container pairs, which meet 4.5:1 contrast", () => {
    const markup = html(createElement(DepartmentHeatmapGrid, { rows }));
    expect(markup).toMatch(/bg-success-container text-on-success-container[^"]*">82%</); // attendance 82: good
    expect(markup).toMatch(/bg-success-container text-on-success-container[^"]*">12%</); // backlog 12: inverted, good
    expect(markup).toMatch(/bg-warning-container text-on-warning-container[^"]*">64%</);
    expect(markup).toMatch(/bg-error-container text-on-error-container[^"]*">41%</);
    expect(markup).not.toMatch(/bg-(success|warning)\/15/);
  });

  it("names a single department in the singular", () => {
    expect(caption(html(createElement(DepartmentHeatmapGrid, { rows: rows.slice(0, 1) })))).toMatch(/^Department performance for 1 department:/);
  });

  it("with no departments, the empty message is unchanged and there is no figure", () => {
    const markup = html(createElement(DepartmentHeatmapGrid, { rows: [] }));
    expect(markup).toContain("No department data available yet.");
    expect(markup).not.toContain("<figure");
  });
});
