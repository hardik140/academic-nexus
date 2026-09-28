import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/modal";

// The shared Button defaults to type="button" so that an untyped Button inside
// a <form> — a Cancel button, say — can never submit it. The real submit
// behaviour is verified in a browser in e2e/gallery.spec.ts.

const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(Button, props, "Label"));

describe("Button type", () => {
  it('renders type="button" when no type is given', () => {
    expect(render()).toMatch(/<button[^>]*\btype="button"/);
  });

  it.each(["submit", "reset", "button"])('keeps an explicit type="%s"', (type) => {
    expect(render({ type })).toMatch(new RegExp(`<button[^>]*\\btype="${type}"`));
  });

  it("renders exactly one type attribute", () => {
    expect(render({ type: "submit" }).match(/\btype=/g)).toHaveLength(1);
  });

  it("still passes other props through", () => {
    const html = render({ disabled: true, "aria-label": "Close", form: "f1" });
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('form="f1"');
  });
});
