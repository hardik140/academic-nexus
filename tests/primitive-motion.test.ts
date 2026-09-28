import { createElement, type ElementType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { DataTable } from "@/components/ui/data-table";
import { StatsCard } from "@/components/ui/stats-card";

// M2 (Checkpoint 4): the shared primitives move only through the semantic
// motion utilities — motion-feedback for interaction feedback, motion-state
// for a status changing meaning — and never through a raw transition-*,
// duration-* or ease-* class. The progress bar and the non-interactive
// card do not move at all. Browser behaviour is in e2e/motion.spec.ts.

const RAW_MOTION = /(?:^|\s)(?:transition(?:-[\w[\]]+)?|duration-[\w[\]]+|ease-[\w[\]-]+)(?=\s|$)/;

/** Every class attribute in the markup. */
function classLists(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
}

/** The class attribute of the first element of `tag` in the markup. */
function classOf(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*\\bclass="([^"]*)"`).exec(html);
  if (!match) throw new Error(`no <${tag}> with a class in: ${html.slice(0, 200)}`);
  return match[1];
}

const render = (type: ElementType, props: Record<string, unknown>, ...children: ReactNode[]) =>
  renderToStaticMarkup(createElement(type, props, ...children));

describe("primitive motion: no raw transition classes anywhere", () => {
  const markup = {
    Button: render(Button, {}, "Save"),
    FormField: render(FormField, { label: "Name", id: "n", value: "", onChange: () => {} }),
    StatusBadge: render(StatusBadge, { status: "pending" }),
    StatsCard: render(StatsCard, { label: "Attendance", value: "86%", progress: { current: 86, max: 100 } }),
  };
  it.each(Object.entries(markup))("%s", (_, html) => {
    for (const list of classLists(html)) expect(list).not.toMatch(RAW_MOTION);
  });
});

describe("Button", () => {
  it.each(["primary", "secondary", "outline", "ghost", "destructive"])("the %s variant uses motion-feedback", (variant) => {
    const cls = classOf(render(Button, { variant }, "Label"), "button").split(" ");
    expect(cls).toContain("motion-feedback");
    expect(cls.some((c) => /^(hover:|active:)?(scale|translate)-/.test(c))).toBe(false);
  });

  it("keeps its disabled styling and type", () => {
    const html = render(Button, { disabled: true }, "Label");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*disabled=""/);
    expect(classOf(html, "button")).toContain("disabled:opacity-50");
  });

  it("a caller's raw transition class cannot displace motion-feedback", () => {
    const cls = classOf(render(Button, { className: "transition-all duration-300" }, "Label"), "button");
    expect(cls).toContain("motion-feedback");
    expect(cls).not.toMatch(RAW_MOTION);
  });
});

describe("FormField", () => {
  it.each([
    ["input", { type: "text" }],
    ["select", { type: "select", options: [{ value: "a", label: "A" }] }],
    ["textarea", { type: "textarea" }],
  ])("the %s uses motion-feedback and keeps its instant focus ring", (tag, extra) => {
    const cls = classOf(render(FormField, { label: "Field", id: "f", value: "", onChange: () => {}, ...extra }), tag);
    expect(cls).toContain("motion-feedback");
    expect(cls).toContain("focus:ring-2");
    expect(cls).not.toContain("transition-all");
  });
});

describe("StatusBadge", () => {
  it.each(["planned", "active", "closed", "reopened", "pending", "something_new"])("%s uses motion-state", (status) => {
    expect(classOf(render(StatusBadge, { status }), "span").split(" ")).toContain("motion-state");
  });

  it("keeps the lifecycle tones, and the closed lock does not move", () => {
    expect(classOf(render(StatusBadge, { status: "planned" }), "span")).toContain("bg-info-container");
    expect(classOf(render(StatusBadge, { status: "active" }), "span")).toContain("bg-success-container");
    expect(classOf(render(StatusBadge, { status: "reopened" }), "span")).toContain("bg-warning-container");
    const closed = render(StatusBadge, { status: "closed" });
    expect(classOf(closed, "span")).toContain("bg-neutral-container");
    expect(classOf(closed, "svg")).toBe("shrink-0");
  });
});

describe("StatsCard", () => {
  const html = render(StatsCard, { label: "Attendance", value: "86%", color: "success", progress: { current: 86, max: 100 } });

  it("is a static panel: no hover shadow and no transition", () => {
    const card = classLists(html)[0];
    expect(card).not.toMatch(/hover:shadow/);
    expect(card).not.toMatch(/motion-|transition|duration-/);
  });

  it("renders its progress bar statically at the final width", () => {
    const bar = /<div class="([^"]*bg-success[^"]*)" style="width:(\d+)%"/.exec(html);
    expect(bar?.[2]).toBe("86");
    expect(bar?.[1]).not.toMatch(/motion-|transition|duration-|animate-/);
  });
});

describe("DataTable controls", () => {
  type Row = { id: string; name: string };
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Student ${i}` }));
  const html = render(DataTable, {
    columns: [{ key: "name", header: "Name", sortable: true }],
    data: rows,
    keyExtractor: (r: Row) => r.id,
    searchKey: "name",
    pageSize: 5,
  });

  it("the search input uses motion-feedback", () => {
    expect(classOf(html, "input")).toContain("motion-feedback");
  });

  it("a sortable header uses motion-feedback", () => {
    expect(classOf(html, "th")).toContain("motion-feedback");
  });

  it("rows use motion-feedback for their hover colour only", () => {
    const row = /<tbody[^>]*>\s*<tr class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(row).toContain("motion-feedback");
    expect(row).not.toMatch(/animate-|transition/);
  });

  it("every pagination button uses motion-feedback", () => {
    const pagination = html.slice(html.lastIndexOf("</table>"));
    const buttons = [...pagination.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(buttons.length).toBeGreaterThanOrEqual(4); // previous, pages, next
    for (const cls of buttons) expect(cls).toContain("motion-feedback");
  });
});
