import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable } from "@/components/ui/data-table";

const render = (serverMode = false) => renderToStaticMarkup(createElement(DataTable, {
  columns: [{ key: "name", header: "Student Name", sortable: true }, { key: "status", header: "Status" }],
  data: [{ id: "1", name: "Asha", status: "Active" }],
  keyExtractor: (row) => String(row.id), serverMode,
}));

describe("DataTable accessibility structure", () => {
  it.each([false, true])("native named sort button in client/server mode %s", (serverMode) => {
    const html = render(serverMode);
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*aria-sort="none"[^>]*><button[^>]*type="button"[^>]*aria-label="Sort by Student Name"[^>]*>Student Name<\/button><\/th>/);
    expect(html).not.toContain('role="button"');
  });
  it("non-sortable columns have no sort state or keyboard control", () => {
    const header = render().match(/<th\b[^>]*>Status<\/th>/)?.[0];
    expect(header).toBeDefined();
    expect(header).not.toMatch(/aria-sort|tabindex|button/);
  });
  it("server markup does not assume overflow and add a desktop tab stop", () => {
    expect(render()).toMatch(/<div[^>]*overflow-x-auto[^>]*tabindex="-1"/);
    expect(render()).not.toContain('tabindex="0"');
  });
  it("retains immediate sorting without custom keyboard handlers", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/ui/data-table.tsx", "utf8");
    expect(source).not.toMatch(/onKeyDown|onKeyUp|scrollBehavior|transition-all|animate-/);
    expect(source).toContain("observer.disconnect()");
  });
});
