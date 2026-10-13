import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/modal";
import { IssueFilters, listIssues, MonitoringNotConfiguredError, MonitoringUnavailableError, PAGE_SIZE, type Issue } from "@/lib/observability/sentry-api";
import { ProviderStatus, LEVEL_STYLE } from "./shared";

/**
 * System Health (Super Admin): crash reports from Sentry, read server-side.
 * Not configured and unreachable are shown as such — never as "no issues".
 * Triage happens in Sentry (each row links there); this page only reads.
 */
type Load =
  | { state: "ok"; issues: Issue[]; total: number | null }
  | { state: "not-configured"; missing: string[] }
  | { state: "unavailable"; message: string };

async function load(filters: IssueFilters): Promise<Load> {
  try {
    return { state: "ok", ...(await listIssues(filters)) };
  } catch (err) {
    if (err instanceof MonitoringNotConfiguredError) return { state: "not-configured", missing: err.missing };
    if (err instanceof MonitoringUnavailableError) return { state: "unavailable", message: err.message };
    throw err;
  }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function SystemHealthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole(["super_admin"]);
  const raw = await searchParams;
  const filters = IssueFilters.parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, one(v)])));
  const result = await load(filters);

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">System Health</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Crash reports from the web app and server, grouped by Sentry. Personal data is removed before a report is sent.
        </p>
      </div>

      <ProviderStatus result={result} />

      <form method="get" className="flex flex-wrap items-end gap-sm" aria-label="Filter issues">
        <Field label="Status" name="status" value={filters.status} options={["unresolved", "resolved", "ignored"]} />
        <Field label="Level" name="level" value={filters.level} options={["any", "fatal", "error", "warning", "info"]} />
        <Field label="Period" name="period" value={filters.period} options={["24h", "7d", "14d"]} />
        <label className="flex flex-col text-xs text-on-surface-variant">
          Environment
          <input name="environment" defaultValue={filters.environment} className="mt-xs rounded-control border border-outline-variant px-sm py-xs text-sm text-on-surface" />
        </label>
        <label className="flex flex-col text-xs text-on-surface-variant">
          Release
          <input name="release" defaultValue={filters.release} className="mt-xs rounded-control border border-outline-variant px-sm py-xs text-sm text-on-surface" />
        </label>
        <label className="flex flex-col text-xs text-on-surface-variant">
          Search
          <input name="search" type="search" defaultValue={filters.search} className="mt-xs rounded-control border border-outline-variant px-sm py-xs text-sm text-on-surface" />
        </label>
        <Button type="submit" size="sm">
          Apply
        </Button>
      </form>

      {result.state === "ok" &&
        (result.issues.length === 0 ? (
          // Reached only when Sentry answered (result.state === "ok"): never on a failed or unconfigured read.
          <div role="status" className="rounded-2xl border border-outline-variant p-lg text-center">
            <p className="font-semibold text-on-surface">No matching issues</p>
            <p className="text-sm text-on-surface-variant mt-xs">
              Sentry reports no {filters.status} issues for these filters in the last {filters.period}.
            </p>
          </div>
        ) : (
          <div className="space-y-sm">
            <p className="text-sm text-on-surface-variant" aria-live="polite">
              {result.total === null ? `${result.issues.length} issues` : `${result.total} matching issues`}
              {result.issues.length >= PAGE_SIZE ? ` — showing the ${PAGE_SIZE} most recently seen` : ""}
            </p>
            <div className="overflow-x-auto rounded-2xl border border-outline-variant">
              <table className="w-full text-sm">
                <caption className="sr-only">Crash issues</caption>
                <thead className="bg-surface-container text-left text-xs uppercase tracking-wider text-outline">
                  <tr>
                    <th scope="col" className="px-sm py-xs">Level</th>
                    <th scope="col" className="px-sm py-xs">Issue</th>
                    <th scope="col" className="px-sm py-xs text-right">Events</th>
                    <th scope="col" className="px-sm py-xs text-right">Users</th>
                    <th scope="col" className="px-sm py-xs">First seen</th>
                    <th scope="col" className="px-sm py-xs">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {result.issues.map((i) => (
                    <tr key={i.id} className="border-t border-outline-variant">
                      <td className="px-sm py-xs">
                        <span className={`rounded-full px-xs py-px text-xs font-medium ${LEVEL_STYLE[i.level] ?? LEVEL_STYLE.info}`}>{i.level}</span>
                      </td>
                      <td className="px-sm py-xs">
                        <Link href={`/super-admin/system-health/${i.id}`} className="font-medium text-on-surface hover:underline">
                          {i.title}
                        </Link>
                        <div className="text-xs text-on-surface-variant">
                          {i.shortId}
                          {i.culprit ? ` · ${i.culprit}` : ""}
                        </div>
                      </td>
                      <td className="px-sm py-xs text-right tabular-nums">{i.count}</td>
                      <td className="px-sm py-xs text-right tabular-nums">{i.userCount ?? "—"}</td>
                      <td className="px-sm py-xs whitespace-nowrap">{formatDate(i.firstSeen, "datetime")}</td>
                      <td className="px-sm py-xs whitespace-nowrap">{formatDate(i.lastSeen, "datetime")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}

function Field({ label, name, value, options }: { label: string; name: string; value: string; options: string[] }) {
  return (
    <label className="flex flex-col text-xs text-on-surface-variant">
      {label}
      <select name={name} defaultValue={value} className="mt-xs rounded-control border border-outline-variant px-sm py-xs text-sm text-on-surface">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
