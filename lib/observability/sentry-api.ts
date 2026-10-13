import { z } from "zod";

/**
 * Reads Sentry's issues for the Super Admin System Health page, server-side.
 *
 * Sentry is where crash reports live (grouping, release tracking, retention);
 * this only reads them, with a token that needs Sentry's `event:read` scope and
 * nothing more. The token stays on the server: it is read here and never sent
 * to the browser. Triage (resolve, ignore, assign) happens in Sentry itself.
 *
 *   SENTRY_ORG, SENTRY_PROJECT   the slugs (also used for source maps)
 *   SENTRY_READ_TOKEN            an `event:read` auth token
 *   SENTRY_API_URL               optional; https://sentry.io by default (de.sentry.io for EU)
 *
 * Three outcomes the page must keep apart: not configured, configured but
 * unreachable or refused, and a real answer. Never "0 issues" for the first two.
 */

export const REQUEST_TIMEOUT_MS = 5000;
export const PAGE_SIZE = 50;

export class MonitoringNotConfiguredError extends Error {
  constructor(readonly missing: string[]) {
    super(`Monitoring is not configured (${missing.join(", ")} not set).`);
    this.name = "MonitoringNotConfiguredError";
  }
}

export class MonitoringUnavailableError extends Error {
  constructor(readonly reason: "refused" | "unreachable" | "bad-response" | "not-found" | "rate-limited") {
    super(
      reason === "refused"
        ? "Sentry refused the read token."
        : reason === "rate-limited"
          ? "Sentry is limiting requests; try again in a minute."
          : reason === "not-found"
          ? "That issue does not exist in this project."
          : reason === "bad-response"
            ? "Sentry returned something unexpected."
            : "Sentry could not be reached."
    );
    this.name = "MonitoringUnavailableError";
  }
}

interface Config {
  base: string;
  org: string;
  project: string;
  token: string;
}

export function monitoringConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ["SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_READ_TOKEN"].filter((k) => !env[k]);
  const base = (env.SENTRY_API_URL || "https://sentry.io").replace(/\/+$/, "");
  // The token is only ever sent over HTTPS, to the configured origin.
  if (!/^https:\/\/[^/?#@]+$/.test(base)) missing.push("SENTRY_API_URL (an https:// origin)");
  if (missing.length) throw new MonitoringNotConfiguredError(missing);
  return { base, org: env.SENTRY_ORG!, project: env.SENTRY_PROJECT!, token: env.SENTRY_READ_TOKEN! };
}

/**
 * A Sentry link the page may render: https on the configured Sentry host or,
 * for sentry.io (any region), a subdomain of sentry.io. Anything else in a
 * response makes it a bad response; it is never linked.
 */
export function isSentryLink(link: string, base: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const host = new URL(base).hostname;
  const root = /(^|\.)sentry\.io$/.test(host) ? "sentry.io" : host;
  return url.protocol === "https:" && !url.username && !url.password && (url.hostname === root || url.hostname.endsWith(`.${root}`));
}

// ── Filters: everything from the URL is allowlisted before it reaches Sentry's query.
export const IssueFilters = z.object({
  status: z.enum(["unresolved", "resolved", "ignored"]).catch("unresolved"),
  level: z.enum(["any", "fatal", "error", "warning", "info"]).catch("any"),
  period: z.enum(["24h", "7d", "14d"]).catch("24h"),
  environment: z.string().regex(/^[\w.-]{1,32}$/).optional().catch(undefined),
  release: z.string().regex(/^[\w.@+-]{1,64}$/).optional().catch(undefined),
  // Words only: no ':' so free text cannot add its own search terms.
  search: z.string().transform((s) => s.replace(/[^\w\s.'-]/g, " ").trim().slice(0, 80)).optional().catch(undefined),
});
export type IssueFilters = z.infer<typeof IssueFilters>;

export function sentryQuery(f: IssueFilters): string {
  const terms = [`is:${f.status}`];
  if (f.level !== "any") terms.push(`level:${f.level}`);
  if (f.environment) terms.push(`environment:${f.environment}`);
  if (f.release) terms.push(`release:${f.release}`);
  if (f.search) terms.push(f.search);
  return terms.join(" ");
}

// ── Responses: only the fields the page shows.
const Issue = z.object({
  id: z.string().regex(/^\d+$/),
  shortId: z.string(),
  title: z.string(),
  culprit: z.string().nullable().optional(),
  level: z.string(),
  status: z.string(),
  count: z.coerce.number(),
  userCount: z.coerce.number().optional(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  permalink: z.string().url().refine((u) => u.startsWith("https://")),
  project: z.object({ slug: z.string() }),
});
export type Issue = z.infer<typeof Issue>;

const Frame = z.object({ filename: z.string().nullable().optional(), function: z.string().nullable().optional(), lineNo: z.number().nullable().optional() });
const LatestEvent = z.object({
  eventID: z.string(),
  dateCreated: z.string().optional(),
  tags: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  entries: z
    .array(
      z.object({
        type: z.string(),
        data: z.unknown(),
      })
    )
    .default([]),
});

export interface IssueDetail {
  issue: Issue;
  exception: { type: string; value: string; frames: { filename: string; function: string; line: number | null }[] }[];
  tags: Record<string, string>;
  lastEventAt?: string;
}

/** Tags shown on the detail page; anything else Sentry holds stays in Sentry. */
const SHOWN_TAGS = ["environment", "release", "routeType", "boundary", "browser", "os", "level", "transaction"];

async function get(cfg: Config, path: string, fetchImpl: typeof fetch): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.base}/api/0${path}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
      redirect: "manual", // the token never follows a redirect to another host
    });
  } catch {
    throw new MonitoringUnavailableError("unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new MonitoringUnavailableError("refused");
  if (res.status === 404) throw new MonitoringUnavailableError("not-found");
  if (res.status === 429) throw new MonitoringUnavailableError("rate-limited");
  if (!res.ok) throw new MonitoringUnavailableError("unreachable");
  return res;
}

async function json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new MonitoringUnavailableError("bad-response");
  return parsed.data;
}

/** The issues matching `filters`, newest activity first, and how many match in all (Sentry's X-Hits). */
export async function listIssues(filters: IssueFilters, deps: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}) {
  const cfg = monitoringConfig(deps.env);
  const params = new URLSearchParams({ query: sentryQuery(filters), statsPeriod: filters.period, limit: String(PAGE_SIZE), sort: "date" });
  const res = await get(cfg, `/projects/${encodeURIComponent(cfg.org)}/${encodeURIComponent(cfg.project)}/issues/?${params}`, deps.fetch ?? fetch);
  const issues = await json(res, z.array(Issue));
  if (!issues.every((i) => isSentryLink(i.permalink, cfg.base))) throw new MonitoringUnavailableError("bad-response");
  const hits = Number(res.headers.get("X-Hits"));
  return { issues, total: Number.isFinite(hits) && res.headers.has("X-Hits") ? hits : null };
}

/** One issue of THIS project (another project in the same org is "not found"), with its latest event. */
export async function getIssue(id: string, deps: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): Promise<IssueDetail> {
  if (!/^\d{1,20}$/.test(id)) throw new MonitoringUnavailableError("not-found");
  const cfg = monitoringConfig(deps.env);
  const f = deps.fetch ?? fetch;
  const org = encodeURIComponent(cfg.org);
  const issue = await json(await get(cfg, `/organizations/${org}/issues/${id}/`, f), Issue);
  if (issue.project.slug !== cfg.project) throw new MonitoringUnavailableError("not-found");
  if (!isSentryLink(issue.permalink, cfg.base)) throw new MonitoringUnavailableError("bad-response");
  const latest = await json(await get(cfg, `/organizations/${org}/issues/${id}/events/latest/`, f), LatestEvent);

  const exception: IssueDetail["exception"] = [];
  for (const entry of latest.entries) {
    if (entry.type !== "exception") continue;
    const values = z.object({ values: z.array(z.object({ type: z.string().nullable().optional(), value: z.string().nullable().optional(), stacktrace: z.object({ frames: z.array(Frame) }).nullable().optional() })) }).safeParse(entry.data);
    if (!values.success) continue;
    for (const v of values.data.values) {
      exception.push({
        type: v.type ?? "Error",
        value: v.value ?? "",
        // Innermost first, at most 20: the location, never source code or variables.
        frames: (v.stacktrace?.frames ?? []).slice(-20).reverse().map((fr) => ({ filename: fr.filename ?? "?", function: fr.function ?? "?", line: fr.lineNo ?? null })),
      });
    }
  }
  const tags = Object.fromEntries(latest.tags.filter((t) => SHOWN_TAGS.includes(t.key)).map((t) => [t.key, t.value]));
  return { issue, exception, tags, lastEventAt: latest.dateCreated };
}
