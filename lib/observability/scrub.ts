import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { classifyError } from "@/lib/feedback-error";

/**
 * What may leave the application in a crash report (OBSERVABILITY.md).
 * Pure, so every rule is unit-tested; used by every capture path — the
 * browser SDK's beforeSend/beforeBreadcrumb and the server's onRequestError.
 *
 * Reports carry the error's type, a redacted message, code locations and
 * route shapes. Never: request bodies, headers, cookies, query strings, user
 * identity, or a value that looks like a credential, an email address, a
 * phone/card number or a record id.
 */

export const MAX_MESSAGE = 500;

const REDACTIONS: [RegExp, string][] = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<jwt>"], // a JWT (Supabase access tokens)
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, "$1 <redacted>"], // an Authorization header's credential
  // A credential-named key and its value, as prose, query string, header or JSON:
  // password: x, access_token=x, "apiKey":"x", Cookie: sb-…=x.
  [/\b(\w*(?:token|api[_-]?key|password|passwd|secret|cookie|authorization|signature|session)\w*)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1$2<redacted>"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b[a-z]{2,6}_(?=\w*\d)\w{8,}\b/g, "<ref>"], // provider ids and keys: pay_…, order_…, sk_live_…
  [/\b(?=[A-Z\d]*\d)(?=[A-Z\d]*[A-Z])[A-Z\d]{6,}\b/g, "<ref>"], // roll and enrolment numbers: 21BCS1234
  [/\b(?=\w*\d)(?=\w*[A-Za-z])\w{24,}\b/g, "<ref>"], // any other long opaque key
  [/\+?\d[\d\s-]{8,}\d/g, "<number>"], // phone, card, account numbers
];

/** Redacts and bounds free text: messages, exception values, breadcrumb text. */
export function scrubText(text: string, max = MAX_MESSAGE): string {
  // Bounded before the patterns run, so a hostile megabyte string costs nothing.
  let out = text.slice(0, max * 4);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** A URL's shape only: no query string or fragment, ids in the path replaced. */
export function scrubUrl(url: string): string {
  const base = url.split(/[?#]/)[0];
  return base
    .split("/")
    .map((segment) => (/^[0-9a-f-]{16,}$/i.test(segment) || /^\d+$/.test(segment) ? ":id" : scrubText(segment, 100)))
    .join("/");
}

/** Thrown on purpose: throttled (lib/rate-limit.ts), invalid input (zod), a request the user cancelled. */
const EXPECTED_NAMES = new Set(["RateLimitError", "ZodError", "AbortError"]);

/**
 * An error the application expects and already shows the user — an expired
 * session, a refused permission, the browser being offline, too many
 * requests, invalid input — is not a crash. Decided by structured signals
 * only (a code, a class name, the browser's offline state), never by message
 * text: the classification that chooses the user's copy (lib/feedback-error).
 * Except Postgres' 42501: the database refusing a privilege the application
 * assumed it had is a grant or RLS defect, so it is reported.
 */
export function isExpectedError(error: unknown): boolean {
  if (error instanceof Error && EXPECTED_NAMES.has(error.name)) return true;
  const { kind } = classifyError(error);
  if (kind === "forbidden") return (error as { code?: unknown }).code !== "42501";
  return kind === "session" || kind === "network";
}

/** Sentry contexts that describe the platform, never the user or their data. */
const SAFE_CONTEXTS = ["trace", "os", "browser", "device", "runtime", "app"];

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  // Console output can hold anything the code logged.
  if (crumb.category === "console") return null;
  const data = crumb.data ?? {};
  const kept: Breadcrumb["data"] = {};
  if (typeof data.url === "string") kept.url = scrubUrl(data.url);
  if (typeof data.method === "string") kept.method = data.method;
  if (typeof data.status_code === "number") kept.status_code = data.status_code;
  if (typeof data.from === "string") kept.from = scrubUrl(data.from);
  if (typeof data.to === "string") kept.to = scrubUrl(data.to);
  return { ...crumb, message: crumb.message ? scrubText(crumb.message) : undefined, data: kept };
}

/** Applied to every event before it is sent. Returns null to drop it. */
export function scrubEvent(event: ErrorEvent, originalException?: unknown): ErrorEvent | null {
  if (originalException !== undefined && isExpectedError(originalException)) return null;
  delete event.user;
  delete event.extra;
  if (event.request) {
    event.request = { url: event.request.url ? scrubUrl(event.request.url) : undefined, method: event.request.method };
  }
  if (event.contexts) event.contexts = Object.fromEntries(Object.entries(event.contexts).filter(([k]) => SAFE_CONTEXTS.includes(k)));
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.message) event.message = scrubText(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = scrubText(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      // Source context and local variables can hold data; the location is enough.
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
      if (frame.abs_path) frame.abs_path = scrubUrl(frame.abs_path);
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  }
  return event;
}
