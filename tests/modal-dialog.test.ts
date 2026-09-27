import { createElement, type ElementType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Modal } from "@/components/ui/modal";

// M4 (Checkpoint 4): the Modal renders a native <dialog> carrying
// motion-dialog, named and described through its own title and description,
// with no simulated overlay. Its behaviour in a browser — showModal(),
// focus, Escape, the backdrop, the inert page, the exit, reduced motion —
// is in e2e/dialog.spec.ts.

const render = (type: ElementType, props: Record<string, unknown>, ...children: ReactNode[]) =>
  renderToStaticMarkup(createElement(type, props, ...children));

const noop = () => {};

/** The opening tag of the first `tag` element in the markup. */
function openingTag(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>`).exec(html);
  if (!match) throw new Error(`no <${tag}> in: ${html.slice(0, 200)}`);
  return match[0];
}

function attr(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

describe("Modal: markup", () => {
  const html = render(
    Modal,
    { open: true, onClose: noop, title: "Edit Asha Rao", description: "22CS041", footer: createElement(Button, {}, "Save") },
    createElement("p", {}, "Body text")
  );
  const dialog = openingTag(html, "dialog");

  it("renders nothing while closed, as before", () => {
    expect(render(Modal, { open: false, onClose: noop, title: "Hidden" }, "Body")).toBe("");
  });

  it("is a native <dialog>, never server-rendered open (showModal() opens it on the client)", () => {
    expect(html.startsWith("<dialog")).toBe(true);
    expect(dialog).not.toMatch(/\sopen[\s=>]/);
    expect(dialog).not.toMatch(/\sinert[\s=>]/);
  });

  it("is named by its title and described by its description", () => {
    const h2 = openingTag(html, "h2");
    const p = openingTag(html, "p");
    expect(attr(dialog, "aria-labelledby")).toBe(attr(h2, "id"));
    expect(attr(dialog, "aria-describedby")).toBe(attr(p, "id"));
    expect(html).toContain(">Edit Asha Rao</h2>");
    expect(html).toContain(">22CS041</p>");
  });

  it("has no aria-describedby without a description", () => {
    const bare = openingTag(render(Modal, { open: true, onClose: noop, title: "Attendance regulations" }, "Body"), "dialog");
    expect(attr(bare, "aria-describedby")).toBeNull();
    expect(attr(bare, "aria-labelledby")).not.toBeNull();
  });

  it("adds no ARIA the native element already supplies", () => {
    expect(dialog).not.toMatch(/\srole=|\saria-modal=/);
  });

  it("carries motion-dialog and the native ::backdrop styling — no fake overlay element", () => {
    const classes = attr(dialog, "class")!.split(/\s+/);
    expect(classes).toContain("motion-dialog");
    expect(classes).toEqual(expect.arrayContaining(["backdrop:bg-black/50", "backdrop:backdrop-blur-sm"]));
    expect(html).not.toMatch(/\bfixed\b|inset-0|\bz-\[|Close dialog/);
  });

  it("uses no keyframe animation and no transition class of its own", () => {
    for (const [, list] of html.matchAll(/class="([^"]*)"/g)) {
      expect(list).not.toMatch(/animate-|transition-all|transition-shadow|transition-\[|transition-colors|duration-|ease-(?:in|out|linear)/);
    }
  });

  it("has one Close control: a named type=button button with motion-feedback", () => {
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    const close = buttons.filter((b) => attr(b, "aria-label") === "Close");
    expect(close).toHaveLength(1);
    expect(attr(close[0], "type")).toBe("button");
    expect(attr(close[0], "class")).toContain("motion-feedback");
    expect(buttons).toHaveLength(2); // Close, and the footer's Save
  });

  it("renders the footer only when one is given", () => {
    expect(render(Modal, { open: true, onClose: noop, title: "No footer" }, "Body")).not.toContain("border-t");
    expect(html).toContain("border-t");
    expect(html).toContain(">Save</button>");
  });

  it.each([
    ["sm", "max-w-[24rem]"],
    ["md", "max-w-[32rem]"],
    ["lg", "max-w-[42rem]"],
    ["xl", "max-w-4xl"],
  ])("size %s keeps its width (%s)", (size, width) => {
    const tag = openingTag(render(Modal, { open: true, onClose: noop, title: "Sized", size }, "Body"), "dialog");
    expect(attr(tag, "class")!.split(/\s+/)).toContain(width);
  });
});
