import { createElement, type ElementType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/ui/data-table";
import { ErrorAlert } from "@/components/ui/error-alert";
import { FormField } from "@/components/ui/modal";
import { SESSION_EXPIRED_MESSAGE, toFeedbackError, type SessionState } from "@/lib/action-failure";
import { signInHref } from "@/lib/auth/safe-redirect";
import { feedbackMessage, SessionExpiredError } from "@/lib/feedback-error";
import { NO_ROWS_CODE, ReadError, requireCount, requireData, requireRows } from "@/lib/read-result";
import { assertRead } from "@/lib/read-result-server";
import {
  addToast,
  dismissToast,
  durationFor,
  elapse,
  EMPTY_QUEUE,
  MAX_VISIBLE,
  MIN_DURATION_MS,
  nextDeadline,
  type ToastQueue,
} from "@/lib/toast-queue";
import PortalError from "@/app/(portal)/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";

// M6.2–M6.8 and Part 10: the toast queue, the failure adapter, the read
// helpers, the sign-in return path, and the markup of ErrorAlert, DataTable's
// failed-load states, FormField's validation state and the route-level pages.
// Browser behaviour is in e2e/m6.spec.ts and e2e/pending.spec.ts.

const render = (type: ElementType, props: Record<string, unknown>, ...children: ReactNode[]) =>
  renderToStaticMarkup(createElement(type, props, ...children));
const noop = () => {};

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Toast queue ─────────────────────────────────────────────────────────

describe("toast queue", () => {
  let n = 0;
  const add = (q: ToastQueue, message: string, id?: string) => addToast(q, { tone: "success", message, id }, `t${++n}`);

  it("shows at most three; the rest wait, in order, and take a free place when one goes", () => {
    let q = EMPTY_QUEUE;
    for (const m of ["one", "two", "three", "four", "five"]) q = add(q, m);
    expect(MAX_VISIBLE).toBe(3);
    expect(q.visible.map((t) => t.message)).toEqual(["one", "two", "three"]);
    expect(q.waiting.map((t) => t.message)).toEqual(["four", "five"]);
    q = dismissToast(q, q.visible[1].id);
    expect(q.visible.map((t) => t.message)).toEqual(["one", "three", "four"]);
    expect(q.waiting.map((t) => t.message)).toEqual(["five"]);
  });

  it("a duplicate — same text, whatever its spacing or case, or the same id — is not added again", () => {
    let q = add(EMPTY_QUEUE, "Invitation resent.");
    q = add(q, "  invitation   RESENT. ");
    expect(q.visible).toHaveLength(1);
    q = add(q, "Saved row 1", "row-1");
    q = add(q, "Saved row 1 again", "row-1");
    expect(q.visible).toHaveLength(2);
    expect(q.visible[1].message).toBe("Saved row 1 again"); // the newer wording, restarted
  });

  it("a duplicate of a shown toast restarts its time; a duplicate of a waiting one is ignored", () => {
    let q = add(EMPTY_QUEUE, "a");
    q = elapse(q, 5000);
    q = add(q, "a");
    expect(q.visible[0].remaining).toBe(MIN_DURATION_MS);
    for (const m of ["b", "c", "d"]) q = add(q, m);
    const before = q;
    expect(add(q, "d")).toBe(before);
  });

  it("stays at least six seconds, longer for long messages, never beyond fifteen", () => {
    expect(MIN_DURATION_MS).toBeGreaterThanOrEqual(6000);
    expect(durationFor("Saved.")).toBe(6000);
    expect(durationFor("x".repeat(150))).toBe(6000 + 50 * 60);
    expect(durationFor("x".repeat(1000))).toBe(15000);
  });

  it("leaves only when its unpaused time is up", () => {
    let q = add(EMPTY_QUEUE, "a");
    q = elapse(q, 5999);
    expect(q.visible).toHaveLength(1);
    expect(nextDeadline(q)).toBe(1);
    q = elapse(q, 1);
    expect(q.visible).toHaveLength(0);
    expect(nextDeadline(q)).toBeNull();
    expect(elapse(q, 0)).toBe(q);
  });

  it("an empty message adds nothing", () => {
    expect(add(EMPTY_QUEUE, "   ")).toBe(EMPTY_QUEUE);
  });
});

// ─── The failure adapter ─────────────────────────────────────────────────

describe("toFeedbackError", () => {
  const state = (s: SessionState) => vi.fn(async () => s);

  it.each(["UNAUTHENTICATED", "PGRST301", "PGRST303"])("the explicit code %s is an expired session, without asking Supabase", async (code) => {
    const ask = state("present");
    expect(await toFeedbackError(Object.assign(new Error("JWT expired"), { code }), "Failed.", ask)).toEqual({ message: SESSION_EXPIRED_MESSAGE, session: true });
    expect(await toFeedbackError(new SessionExpiredError(), "Failed.", ask)).toEqual({ message: SESSION_EXPIRED_MESSAGE, session: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it("a network failure says so, without claiming the session ended", async () => {
    const ask = state("missing");
    const result = await toFeedbackError(new TypeError("Failed to fetch"), "Failed.", ask);
    expect(result.session).toBe(false);
    expect(result.message).toMatch(/Couldn't reach the server/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("otherwise asks Supabase directly: no user left means the session ended (D11 fallback)", async () => {
    expect(await toFeedbackError(new Error("An error occurred in the Server Components render."), "Failed.", state("missing"))).toEqual({
      message: SESSION_EXPIRED_MESSAGE,
      session: true,
    });
  });

  it("when Supabase cannot be asked, it does not claim the session ended", async () => {
    expect((await toFeedbackError(new Error("Something"), "Failed.", state("unknown"))).session).toBe(false);
  });

  it("a signed-in user sees a deliberate business message, but never database detail or a digest's text", async () => {
    const present = state("present");
    expect((await toFeedbackError(new Error("This gate pass must be approved first."), "Failed.", present)).message).toBe("This gate pass must be approved first.");
    expect((await toFeedbackError(new Error('duplicate key value violates unique constraint "fees_pkey"'), "Failed to save.", present)).message).toBe("Failed to save.");
    expect((await toFeedbackError(Object.assign(new Error("An error occurred in the Server Components render."), { digest: "123" }), "Failed to save.", present)).message).toBe(
      "Failed to save."
    );
    expect((await toFeedbackError("a string", "Failed to save.", present)).message).toBe("Failed to save.");
  });

  it("feedbackMessage never passes internal text through", () => {
    expect(feedbackMessage(new Error('relation "profiles" does not exist'), "Failed.")).toBe("Failed.");
    expect(feedbackMessage(new Error("   "), "Failed.")).toBe("Failed.");
  });
});

// ─── Read helpers ────────────────────────────────────────────────────────

describe("read helpers: a failed read is never an empty result", () => {
  it("requireRows throws a ReadError keeping the code, not the message; [] only for a successful empty read", () => {
    const failure = { data: null, error: { code: "42501", message: 'permission denied for table "fees"' } };
    expect(() => requireRows(failure)).toThrow(ReadError);
    try {
      requireRows(failure);
    } catch (e) {
      expect((e as ReadError).code).toBe("42501");
      expect((e as Error).message).not.toMatch(/fees|permission/);
    }
    expect(requireRows({ data: null, error: null })).toEqual([]);
    expect(requireRows({ data: [1, 2], error: null })).toEqual([1, 2]);
  });

  it("requireData: no row from .single() is null; any other failure throws", () => {
    expect(requireData({ data: null, error: { code: NO_ROWS_CODE } })).toBeNull();
    expect(requireData({ data: { id: 1 }, error: null })).toEqual({ id: 1 });
    expect(() => requireData({ data: null, error: { code: "PGRST301" } })).toThrow(ReadError);
  });

  it("requireCount: 0 only when the count succeeded", () => {
    expect(requireCount({ count: null, error: null })).toBe(0);
    expect(requireCount({ count: 7, error: null })).toBe(7);
    expect(() => requireCount({ count: null, error: { code: "500" } })).toThrow(ReadError);
  });

  it("assertRead (server) throws a safe error for a failure, and lets no-row through", () => {
    const log = vi.spyOn(console, "error").mockImplementation(noop);
    expect(() => assertRead(null)).not.toThrow();
    expect(() => assertRead({ code: NO_ROWS_CODE })).not.toThrow();
    expect(() => assertRead({ code: "42P01", message: 'relation "fees" does not exist' })).toThrow();
    try {
      assertRead({ code: "42P01", message: 'relation "fees" does not exist' });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/relation|fees/);
    }
    expect(log).toHaveBeenCalled(); // operators still get the detail
  });
});

// ─── Sign in again ───────────────────────────────────────────────────────

describe("signInHref: back to the same page after signing in, and nowhere else", () => {
  it.each([
    ["/director/team", "/login?next=%2Fdirector%2Fteam"],
    ["/finance/invoices?status=overdue", "/login?next=%2Ffinance%2Finvoices%3Fstatus%3Doverdue"],
    ["/", "/login"],
    ["//evil.example/x", "/login"],
    ["https://evil.example/x", "/login"],
    ["/\\evil.example", "/login"],
    ["javascript:alert(1)", "/login"],
    ["/login?next=/x", "/login"],
  ])("%s → %s", (current, href) => {
    expect(signInHref(current)).toBe(href);
  });
});

// ─── ErrorAlert ──────────────────────────────────────────────────────────

describe("ErrorAlert", () => {
  it("is always a role=alert region, empty until there is an error", () => {
    const html = render(ErrorAlert, { error: null });
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).not.toContain("data-tone");
  });

  it("shows a message, and for an expired session a same-tab Sign in again link", () => {
    const plain = render(ErrorAlert, { error: { message: "Failed to save.", session: false } });
    expect(plain).toContain("Failed to save.");
    expect(plain).not.toContain("Sign in again");
    const session = render(ErrorAlert, { error: { message: SESSION_EXPIRED_MESSAGE, session: true } });
    expect(session).toMatch(/<a [^>]*href="\/login"[^>]*>Sign in again<\/a>/);
    expect(session).not.toContain("target=");
  });
});

// ─── DataTable failed loads ──────────────────────────────────────────────

describe("DataTable: failed loads (D5)", () => {
  const props = {
    columns: [{ key: "name", header: "Name" }],
    keyExtractor: (r: { id: string }) => r.id,
    emptyMessage: "No students found.",
    onRetry: noop,
  };

  it("a failed load with no rows is an error with Try again — never the empty message, never the error's text", () => {
    const html = render(DataTable, { ...props, data: [], error: new Error('relation "students" does not exist') });
    expect(html).toContain('role="alert"');
    expect(html).toContain("data-error-state");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No students found.");
    expect(html).not.toContain("relation");
  });

  it("a failed refresh keeps the rows, beside an error that says so", () => {
    const html = render(DataTable, { ...props, data: [{ id: "1", name: "Asha Rao" }], error: new Error("x") });
    expect(html).toContain("Asha Rao");
    expect(html).toContain("This couldn&#x27;t be refreshed. Showing what was loaded earlier.");
    expect(html).not.toContain("data-error-state");
  });

  it("a successful empty load is the empty message, with the alert region present but empty", () => {
    const html = render(DataTable, { ...props, data: [], error: null });
    expect(html).toContain("No students found.");
    expect(html).toMatch(/<div role="alert"[^>]*class="[^"]*sr-only[^"]*"><\/div>/);
  });

  it("marks the table busy while loading", () => {
    expect(render(DataTable, { ...props, data: [], loading: true })).toContain('aria-busy="true"');
  });
});

// ─── FormField validation ────────────────────────────────────────────────

describe("FormField validation state (Part 10)", () => {
  it.each(["text", "textarea", "select"])("a %s with an error is aria-invalid and described by its message", (type) => {
    const html = render(FormField, { label: "Title", id: "f-title", type, value: "", onChange: noop, options: [{ value: "a", label: "A" }], error: "Enter a title." });
    const control = /<(input|textarea|select)\b[^>]*>/.exec(html)![0];
    expect(control).toContain('aria-invalid="true"');
    expect(control).toContain('aria-describedby="f-title-error"');
    expect(html).toMatch(/<p[^>]*id="f-title-error"[^>]*>Enter a title\.<\/p>/);
  });

  it("without an error: no aria-invalid, no dangling aria-describedby", () => {
    const html = render(FormField, { label: "Title", id: "f-title", value: "", onChange: noop });
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("f-title-error");
  });
});

// ─── Route-level pages (M6.8) ────────────────────────────────────────────

describe("route-level error pages", () => {
  const secret = Object.assign(new Error('relation "fees" does not exist at /srv/app/lib/finance.ts:42'), { digest: "4096731234" });

  it("the portal error boundary: an alert with Try again, a way to the dashboard, the digest as a reference, and no raw error", () => {
    const html = render(PortalError, { error: secret, retry: noop });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).toContain("Go to your dashboard");
    expect(html).toContain("4096731234");
    expect(html).not.toMatch(/relation|fees|\/srv\/|finance\.ts/);
    expect(html).not.toMatch(/animate-|transition-|motion-(?!feedback)/);
  });

  it("an expired session offers Sign in again instead of the dashboard", () => {
    const html = render(PortalError, { error: new SessionExpiredError(), retry: noop });
    expect(html).toContain("Sign in again");
    expect(html).not.toContain("Go to your dashboard");
  });

  it("the global error page is a full document with its own title, Try again and a way home, and no raw error", () => {
    const html = render(GlobalError, { error: secret, retry: noop });
    expect(html).toMatch(/^<html/);
    expect(html).toContain("<body");
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(html).not.toMatch(/relation|fees|\/srv\//);
  });

  it("not-found is a plain page — a heading and a way home, not an alert", () => {
    const html = render(NotFound, {});
    expect(html).toMatch(/<h1[^>]*>This page couldn(?:&#x27;|')t be found<\/h1>/);
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(html).not.toContain('role="alert"');
  });
});
