import { createElement, type ElementType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, type AlertTone } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { selectView, StateView, type ViewKind } from "@/components/ui/state-view";
import type { AsyncResourceState } from "@/lib/async-resource";
import { classifyError, type ErrorKind } from "@/lib/feedback-error";

// M6.1: the feedback foundation's markup and state selection. Behaviour in a
// browser — announcements, Dismiss by keyboard, the entrance motion, reduced
// motion, axe — is in e2e/feedback.spec.ts.

const render = (type: ElementType, props: Record<string, unknown>, ...children: ReactNode[]) =>
  renderToStaticMarkup(createElement(type, props, ...children));

const noop = () => {};

function openingTag(html: string, selector: RegExp): string {
  const match = selector.exec(html);
  if (!match) throw new Error(`no match for ${selector} in: ${html.slice(0, 300)}`);
  return match[0];
}

const firstTag = (html: string) => openingTag(html, /<\w+\b[^>]*>/);
const boxTag = (html: string) => openingTag(html, /<div[^>]*data-tone="[^"]*"[^>]*>/);

// ─── Alert ───────────────────────────────────────────────────────────────

describe("Alert", () => {
  const TONES: AlertTone[] = ["success", "info", "warning", "error"];

  it.each([
    ["success", "status"],
    ["info", "status"],
    ["warning", "status"],
    ["error", "alert"],
  ] as const)("a %s message is a role=%s live region", (tone, role) => {
    const html = render(Alert, { tone }, "Leave application submitted.");
    expect(firstTag(html)).toContain(`role="${role}"`);
  });

  it.each(TONES)("an empty %s Alert keeps its live region mounted, out of the layout", (tone) => {
    for (const message of [null, undefined, false, ""]) {
      const html = render(Alert, { tone, className: "mt-md" }, message as ReactNode);
      const region = firstTag(html);
      expect(region).toContain(`role="${tone === "error" ? "alert" : "status"}"`);
      expect(region).toContain("sr-only");
      expect(region).not.toContain("mt-md");
      expect(html).not.toContain("data-tone");
    }
  });

  it.each([
    ["success", "Success"],
    ["info", "Information"],
    ["warning", "Warning"],
    ["error", "Error"],
  ] as const)("names the %s tone in text, not only by colour and icon", (tone, label) => {
    const html = render(Alert, { tone }, "Message");
    expect(html).toContain(`<span class="sr-only">${label}: </span>Message`);
    const withTitle = render(Alert, { tone, title: "Saved" }, "Details");
    expect(withTitle).toContain(`<span class="sr-only">${label}: </span>Saved`);
    expect(withTitle.match(/sr-only">[A-Za-z]+: </g)).toHaveLength(1);
  });

  it.each([
    ["success", "bg-success-container", "text-on-success-container"],
    ["info", "bg-info-container", "text-on-info-container"],
    ["warning", "bg-warning-container", "text-on-warning-container"],
    ["error", "bg-error-container", "text-on-error-container"],
  ] as const)("the %s message uses its container token pair", (tone, bg, text) => {
    const box = boxTag(render(Alert, { tone }, "Message"));
    expect(box).toContain(bg);
    expect(box).toContain(text);
  });

  it("success, info and warning fade in with motion-appear; an error appears with no motion at all", () => {
    for (const tone of ["success", "info", "warning"] as const) {
      expect(boxTag(render(Alert, { tone }, "Message"))).toContain("motion-appear");
    }
    const error = render(Alert, { tone: "error" }, "Message");
    expect(error).not.toMatch(/motion-appear|motion-state|transition|duration-|animate-/);
  });

  it("Dismiss is a named, typed button, shown only when onDismiss is given", () => {
    const withDismiss = render(Alert, { tone: "error", onDismiss: noop }, "Message");
    const button = openingTag(withDismiss, /<button\b[^>]*>/);
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="Dismiss"');
    expect(render(Alert, { tone: "error" }, "Message")).not.toContain("<button");
  });

  it("an Alert with a message applies the caller's layout classes", () => {
    const region = firstTag(render(Alert, { tone: "info", className: "mt-md" }, "Message"));
    expect(region).toContain("mt-md");
    expect(region).not.toContain("sr-only");
  });

  it("renders a follow-up action", () => {
    const html = render(Alert, { tone: "error", action: createElement("button", { type: "button" }, "Try again") }, "Failed");
    expect(html).toContain(">Try again</button>");
  });
});

// ─── LoadingState / EmptyState / ErrorState ─────────────────────────────

describe("LoadingState", () => {
  it("is not a live region unless asked to announce", () => {
    const html = render(LoadingState, { label: "Loading refunds…" });
    expect(html).not.toMatch(/role=|aria-live/);
    expect(html).toContain("Loading refunds…");
  });

  it("announces as a status message when asked", () => {
    expect(firstTag(render(LoadingState, { announce: true }))).toContain('role="status"');
  });

  it("is static: nothing spins, pulses or transitions", () => {
    for (const variant of ["inline", "section", "page"]) {
      expect(render(LoadingState, { variant, announce: true })).not.toMatch(/animate-|transition|motion-|duration-/);
    }
  });
});

describe("EmptyState", () => {
  it("is plain content: no role, no live region", () => {
    const html = render(EmptyState, { title: "No refund requests", description: "Requests will appear here." });
    expect(html).not.toMatch(/role=|aria-live|aria-busy/);
    expect(html).toContain("No refund requests");
    expect(html).toContain("Requests will appear here.");
  });
});

describe("ErrorState", () => {
  const KINDS: ErrorKind[] = ["load", "network", "forbidden", "session", "not-found", "unknown"];

  it.each(KINDS)("the %s error is a role=alert region with its own copy and no motion", (kind) => {
    const html = render(ErrorState, { kind });
    expect(firstTag(html)).toContain('role="alert"');
    // The error has no motion of its own. A control inside it (Sign in again,
    // Try again) keeps the hover feedback every control has: motion-feedback,
    // on that control's own tag and nowhere else.
    expect(firstTag(html)).not.toMatch(/motion-|transition|animate-|duration-/);
    expect(html.replace(/<(?:a|button)\b[^>]*>/g, "")).not.toMatch(/motion-|transition|animate-|duration-/);
    expect(html).not.toMatch(/motion-(?!feedback)/);
    expect(html).toMatch(/<p class="[^"]*font-semibold[^"]*">[^<]+<\/p>/);
  });

  it("uses the owner's wording for an expired session", () => {
    const html = render(ErrorState, { kind: "session" });
    expect(html).toContain("Your session has expired");
    expect(html).toContain("Please sign in again.");
  });

  it.each(["load", "network", "unknown"] as const)("offers Try again for a %s failure when a retry is given", (kind) => {
    expect(render(ErrorState, { kind, onRetry: noop })).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
    expect(render(ErrorState, { kind })).not.toContain("<button");
  });

  it.each(["forbidden", "session", "not-found"] as const)("never offers Try again for a %s failure: retrying cannot help", (kind) => {
    expect(render(ErrorState, { kind, onRetry: noop })).not.toContain("Try again");
  });

  it("shows the digest as a reference, and nothing else from the error", () => {
    const html = render(ErrorState, { kind: "load", reference: "1839204761" });
    expect(html).toContain("Reference: <span");
    expect(html).toContain("1839204761");
  });

  it("does not accept an Error to print", () => {
    // The props have no `error`: a caller cannot pass one through by accident.
    const html = render(ErrorState, { kind: "load", error: new Error("relation \"refunds\" does not exist") });
    expect(html).not.toContain("relation");
  });
});

// ─── StateView: state selection ─────────────────────────────────────────

type Rows = string[];
const loading = (data?: Rows): AsyncResourceState<Rows> => ({ status: "loading", data, error: undefined });
const success = (data: Rows): AsyncResourceState<Rows> => ({ status: "success", data, error: undefined });
const failure = (data?: Rows, error: unknown = new Error("x")): AsyncResourceState<Rows> => ({ status: "error", data, error });

describe("StateView: selectView", () => {
  it.each([
    ["first load", loading(), { view: "loading", busy: true, staleError: false }],
    ["success with records", success(["a"]), { view: "data", busy: false, staleError: false }],
    ["success with nothing", success([]), { view: "empty", busy: false, staleError: false }],
    ["first load failed", failure(), { view: "error", busy: false, staleError: false }],
    ["reload over records", loading(["a"]), { view: "data", busy: true, staleError: false }],
    ["reload over an empty result", loading([]), { view: "empty", busy: true, staleError: false }],
    ["reload failed, records kept", failure(["a"]), { view: "data", busy: false, staleError: true }],
    ["reload failed after an empty result", failure([]), { view: "error", busy: false, staleError: false }],
  ] as const)("%s", (_, state, expected) => {
    expect(selectView(state)).toEqual(expected);
  });

  it("a failed load is never shown as empty, whatever data it carries or however emptiness is judged", () => {
    const datas: Array<Rows | undefined> = [undefined, [], ["a"], ["a", "b"]];
    const judges = [undefined, () => true, () => false, (d: Rows) => d.length < 2];
    for (const data of datas) {
      for (const isEmpty of judges) {
        for (const error of [new Error("x"), undefined, null, "text", { code: "42501" }]) {
          expect(selectView(failure(data, error), isEmpty).view).not.toBe("empty");
        }
      }
    }
  });

  it("rejects invalid states as errors: never empty, never data", () => {
    const invalid = [
      { status: "success", data: undefined, error: undefined },
      { status: "done", data: [], error: undefined },
      { status: undefined, data: ["a"], error: undefined },
      { status: "SUCCESS", data: [], error: undefined },
    ];
    for (const state of invalid) {
      expect(selectView(state as unknown as AsyncResourceState<Rows>)).toEqual({ view: "error", busy: false, staleError: false });
    }
  });

  it("treats null as empty by default, and lets the caller judge emptiness", () => {
    expect(selectView<Rows | null>({ status: "success", data: null, error: undefined }).view).toBe("empty");
    expect(selectView(success(["a"]), () => true).view).toBe("empty");
  });
});

// ─── StateView: markup ──────────────────────────────────────────────────

describe("StateView: markup", () => {
  const empty = { title: "No refund requests" };
  const list = (rows: Rows) => createElement("ul", { "data-rows": "" }, rows.map((r) => createElement("li", { key: r }, r)));
  const view = (state: AsyncResourceState<Rows> & { reload?: () => void }, extra: Record<string, unknown> = {}) =>
    render(StateView, { state, empty, children: list, ...extra });
  const region = (html: string) => openingTag(html, /<div[^>]*data-view="[^"]*"[^>]*>/);

  const rendered = (html: string): ViewKind[] => {
    const found: ViewKind[] = [];
    if (html.includes("data-loading-state") && !html.includes("Refreshing…")) found.push("loading");
    if (html.includes("data-empty-state")) found.push("empty");
    if (html.includes("data-rows")) found.push("data");
    if (html.includes("data-error-state")) found.push("error");
    return found;
  };

  it("renders exactly one of loading, empty, data and error", () => {
    expect(rendered(view(loading()))).toEqual(["loading"]);
    expect(rendered(view(success([])))).toEqual(["empty"]);
    expect(rendered(view(success(["a"])))).toEqual(["data"]);
    expect(rendered(view(failure()))).toEqual(["error"]);
    expect(rendered(view(failure([])))).toEqual(["error"]);
  });

  it("marks the region busy while loading, and only then", () => {
    expect(region(view(loading()))).toContain('aria-busy="true"');
    expect(region(view(loading(["a"])))).toContain('aria-busy="true"');
    for (const state of [success([]), success(["a"]), failure(), failure(["a"])]) {
      expect(region(view(state))).not.toContain("aria-busy");
    }
  });

  it("a reload keeps the earlier records, marked as refreshing", () => {
    const html = view(loading(["a"]));
    expect(html).toContain("data-rows");
    expect(html).toContain("Refreshing…");
  });

  it("a failed reload keeps the earlier records beside an error Alert with Try again", () => {
    const html = view({ ...failure(["a"]), reload: noop });
    expect(html).toContain("data-rows");
    expect(html).toMatch(/role="alert"[\s\S]*couldn&#x27;t be refreshed[\s\S]*>Try again<\/button>/);
    expect(html).not.toContain("data-empty-state");
  });

  it("a failed load offers Try again from the resource's reload", () => {
    expect(view({ ...failure(), reload: noop })).toMatch(/data-error-state="load"[\s\S]*>Try again<\/button>/);
    expect(view(failure())).not.toContain("<button");
  });

  it("classifies the failure: a permission refusal has no Try again", () => {
    const html = view({ ...failure(undefined, { code: "42501" }), reload: noop });
    expect(html).toContain('data-error-state="forbidden"');
    expect(html).not.toContain("Try again");
  });

  it("shows a digest as the reference, never the error message", () => {
    const html = view(failure(undefined, Object.assign(new Error("duplicate key value violates constraint"), { digest: "4242" })));
    expect(html).toContain("4242");
    expect(html).not.toContain("duplicate key");
  });

  it("keeps one status region mounted outside the busy region, filled only when announcing", () => {
    const status = /^<p role="status" class="sr-only">([^<]*)<\/p><div/;
    expect(view(loading())).toMatch(status);
    expect(status.exec(view(loading()))?.[1]).toBe("");
    expect(status.exec(view(loading(["a"]), { announceLoading: true, loadingLabel: "Loading refunds…" }))?.[1]).toBe("Loading refunds…");
    expect(status.exec(view(success(["a"]), { announceLoading: true }))?.[1]).toBe("");
  });

  it("never calls children for anything but data", () => {
    const children = vi.fn(list);
    for (const state of [loading(), success([]), failure(), failure([]), loading([])]) {
      render(StateView, { state, empty, children });
    }
    expect(children).not.toHaveBeenCalled();
  });
});

// ─── classifyError ──────────────────────────────────────────────────────

describe("classifyError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [{ code: "UNAUTHENTICATED" }, "session"],
    [{ code: "PGRST301" }, "session"],
    [{ code: "PGRST303" }, "session"],
    [{ code: "FORBIDDEN" }, "forbidden"],
    [{ code: "INACTIVE" }, "forbidden"],
    [{ code: "42501" }, "forbidden"],
    [new TypeError("Failed to fetch"), "network"],
    [new TypeError("NetworkError when attempting to fetch resource."), "network"],
    [new TypeError("Load failed"), "network"],
    [new Error("Failed to fetch"), "load"],
    [new TypeError("x is not a function"), "load"],
    [new Error("You do not have permission"), "load"],
    [new Error("session expired"), "load"],
    [undefined, "load"],
    [null, "load"],
    ["Failed to fetch", "load"],
    [{ code: 23505 }, "load"],
  ] as const)("%o → %s", (error, kind) => {
    expect(classifyError(error).kind).toBe(kind);
  });

  it("reports the browser being offline as a network failure", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(classifyError(new Error("anything")).kind).toBe("network");
  });

  it("keeps a Next.js digest as the reference", () => {
    expect(classifyError(Object.assign(new Error("masked"), { digest: "1839204761" }))).toEqual({ kind: "load", reference: "1839204761" });
    expect(classifyError(new Error("x"))).toEqual({ kind: "load" });
  });
});
