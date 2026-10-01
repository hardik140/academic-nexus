import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SidebarContent } from "@/components/portal/portal-shell";
import { SAMPLE_PROFILE } from "@/app/dev/shell/sample";
import navigation from "./sidebar-navigation.fixture.json";

const states = ["expanded", "collapsed", "drawer"] as const;
type State = typeof states[number];
const render = (role: string, pathname: string, state: State) => renderToStaticMarkup(createElement(SidebarContent, {
  profile: { ...SAMPLE_PROFILE, role: role as typeof SAMPLE_PROFILE.role },
  pathname, expanded: state !== "collapsed", onNavigate: () => {},
  onClose: state === "drawer" ? () => {} : undefined,
}));
const links = (html: string) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], content: m[2] }));
const current = (html: string) => links(html).filter((a) => a.attrs.includes('aria-current="page"')).map((a) => a.attrs.match(/href="([^"]+)"/)?.[1]);
const scopes = (href: string) => href === "/director/placements/funnel" ? "/director/placements" : href;

for (const [role, items] of Object.entries(navigation)) {
  describe(`${role} sidebar`, () => {
    it.each(states)("%s preserves native links, label text, decorative icons and order", (state) => {
      const html = render(role, items[0].href, state);
      const anchors = links(html);
      expect(anchors).toHaveLength(items.length);
      anchors.forEach((a, i) => {
        expect(a.attrs).toContain(`href="${items[i].href}"`);
        expect(a.attrs).not.toMatch(/role=|aria-label=|aria-describedby=|tabindex=/);
        expect(a.content).toContain(`<span aria-hidden="true" class="text-base shrink-0">${items[i].icon}</span>`);
        expect(a.content).toContain(`<span class="${state === "collapsed" ? "sr-only" : "truncate"}">${items[i].label}</span>`);
        // Removing the decorative subtree leaves exactly the configured name.
        expect(a.content.replace(/<span aria-hidden="true"[^>]*>.*?<\/span>/g, "").replace(/<[^>]+>/g, "")).toBe(items[i].label);
      });
      expect(html).toMatch(/<nav class=/);
      expect(html).not.toContain('role="navigation"');
      expect(current(html)).toEqual([items[0].href]);
    });
    it("all destinations match exact and descendant paths, excluding lookalike prefixes and other roles", () => {
      for (const item of items) {
        for (const path of [item.href, `${scopes(item.href)}/record/detail`]) {
          expect(current(render(role, path, "collapsed")), path).toEqual([item.href]);
        }
        for (const path of [`${scopes(item.href)}-archive`, `${scopes(item.href)}ish`, "/", `/${role}`]) {
          expect(current(render(role, path, "collapsed")), path).toEqual([]);
        }
      }
      if (role !== "director") expect(current(render(role, "/director/placements/funnel", "expanded"))).toEqual([]);
    });
  });
}

const matrix: [string, string | null][] = [
  ["/director/placements", "/director/placements/funnel"],
  ["/director/placements/funnel", "/director/placements/funnel"],
  ["/director/departments/performance", "/director/departments"],
  ["/director/departments/performance/00000000-0000-4000-8000-000000000003", "/director/departments"],
  ["/director/placements-extra", null],
  ["/director/departments-other", null],
  ["/director/dashboard", "/director/dashboard"],
  ["/director", null],
  ["/", null],
];
for (const state of states) {
  it.each(matrix)(`${state}: %s has only the appropriate current section`, (path, href) => {
    const html = render("director", path, state);
    expect(current(html)).toEqual(href ? [href] : []);
    expect(html.match(/aria-current=/g)?.length ?? 0).toBe(href ? 1 : 0);
    const activeLinks = links(html).filter((a) => a.attrs.includes("bg-secondary"));
    expect(activeLinks).toHaveLength(href ? 1 : 0);
  });
}
it("retains the existing unknown-role student fallback", () => {
  expect(links(render("unknown", "/student/dashboard", "collapsed"))).toHaveLength(navigation.student.length);
  expect(current(render("unknown", "/student/dashboard", "collapsed"))).toEqual(["/student/dashboard"]);
});
it("uses native keyboard behavior and adds no motion", () => {
  const source = readFileSync("components/portal/portal-shell.tsx", "utf8");
  expect(source).not.toMatch(/onKeyDown|onKeyUp|transition-all|animate-/);
  expect(source).toContain('sidebarOpen ? "w-64" : "w-[72px]"');
  expect(source).toContain('const DESKTOP_QUERY = "(min-width: 64rem)"');
});
