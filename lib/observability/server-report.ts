import { isExpectedError, scrubText, scrubUrl } from "./scrub";

/**
 * Server errors, from Next.js's onRequestError (instrumentation.ts): every
 * Server Component render, Route Handler, Server Action and proxy failure.
 *
 * Two outputs, both scrubbed (lib/observability/scrub.ts):
 *   1. one JSON line on console.error — Cloudflare Workers observability
 *      (wrangler.jsonc) collects it with no further setup;
 *   2. when SENTRY_DSN is set, one event to Sentry, posted directly to its
 *      envelope endpoint. The Sentry Node SDK is not loaded in the Worker:
 *      it is unverified on the OpenNext Workers runtime, and an envelope is
 *      one bounded fetch.
 *
 * Never throws and never changes the response: reporting failures are
 * swallowed after one log line (without the event), and the send is bounded
 * by SEND_TIMEOUT_MS.
 */

export const SEND_TIMEOUT_MS = 2000;
const MAX_FRAMES = 30;

export interface RequestInfo {
  path: string;
  method: string;
}
export interface RouteContext {
  routePath: string;
  routeType: string;
}

interface Frame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
}

/** V8 stack lines ("    at fn (file:line:col)" or "    at file:line:col"), innermost first. */
export function parseStack(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    frames.push({ function: m[1], filename: scrubUrl(m[2]), lineno: Number(m[3]), colno: Number(m[4]) });
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

/** https://<public key>@<host>[/<path>]/<project id> → where and how to post. */
export function parseDsn(dsn: string): { url: string; key: string } | null {
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!u.username || !project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return { url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, key: u.username };
  } catch {
    return null;
  }
}

function field(err: unknown, name: string): string | undefined {
  if (typeof err !== "object" || err === null || !(name in err)) return undefined;
  const v = (err as Record<string, unknown>)[name];
  return typeof v === "string" ? v : undefined;
}

export async function reportServerError(
  err: unknown,
  request: RequestInfo,
  context: RouteContext,
  deps: { fetch?: typeof fetch; dsn?: string } = {}
): Promise<void> {
  try {
    await report(err, request, context, deps);
  } catch {
    // A hostile error (a throwing getter or toString) must not become a second failure.
    console.warn(JSON.stringify({ event: "observability.send", outcome: "failed", reason: "unreportable" }));
  }
}

async function report(err: unknown, request: RequestInfo, context: RouteContext, deps: { fetch?: typeof fetch; dsn?: string }): Promise<void> {
  if (isExpectedError(err)) return;
  const name = err instanceof Error ? err.name : "NonError";
  const message = scrubText(err instanceof Error ? err.message : String(err));
  const digest = field(err, "digest");
  const route = context.routePath;
  const tags = { routeType: context.routeType, method: request.method, ...(digest ? { digest } : {}) };

  console.error(JSON.stringify({ event: "server.error", name, message, route, ...tags }));

  const target = parseDsn(deps.dsn ?? process.env.SENTRY_DSN ?? "");
  if (!target) return;
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_REDIS_BUILD_ID,
    transaction: route,
    tags,
    request: { url: scrubUrl(request.path), method: request.method },
    exception: {
      // Sentry lists frames outermost first.
      values: [{ type: name, value: message, stacktrace: { frames: parseStack(err instanceof Error ? err.stack : undefined).reverse() } }],
    },
  };
  const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
  try {
    const res = await (deps.fetch ?? fetch)(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=academic-nexus/1` },
      body,
      redirect: "manual", // an ingest endpoint never redirects; a 3xx is a rejection, not a new destination
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(JSON.stringify({ event: "observability.send", outcome: "rejected", status: res.status }));
  } catch (e) {
    console.warn(JSON.stringify({ event: "observability.send", outcome: "failed", reason: (e as Error).name }));
  }
}
