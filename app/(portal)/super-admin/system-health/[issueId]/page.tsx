import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { formatDate } from "@/lib/format";
import { getIssue, MonitoringNotConfiguredError, MonitoringUnavailableError, type IssueDetail } from "@/lib/observability/sentry-api";
import { ProviderStatus, LEVEL_STYLE } from "../shared";

/**
 * One crash issue: its counts and dates, and the latest event's exception
 * and code locations — already scrubbed before it was sent (OBSERVABILITY.md).
 * Source code, variables and request data are never shown; Sentry's own page
 * (linked) is where triage happens.
 */
export default async function IssuePage({ params }: { params: Promise<{ issueId: string }> }) {
  await requireRole(["super_admin"]);
  const { issueId } = await params;

  let detail: IssueDetail;
  try {
    detail = await getIssue(issueId);
  } catch (err) {
    if (err instanceof MonitoringNotConfiguredError) return <Shell><ProviderStatus result={{ state: "not-configured", missing: err.missing }} /></Shell>;
    if (err instanceof MonitoringUnavailableError) return <Shell><ProviderStatus result={{ state: "unavailable", message: err.message }} /></Shell>;
    throw err;
  }
  const { issue, exception, tags } = detail;

  return (
    <Shell>
      <div>
        <h1 className="text-xl font-extrabold text-on-surface break-words">{issue.title}</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          <span className={`rounded-full px-xs py-px text-xs font-medium ${LEVEL_STYLE[issue.level] ?? LEVEL_STYLE.info}`}>{issue.level}</span> {issue.shortId}
          {issue.culprit ? ` · ${issue.culprit}` : ""} · {issue.status}
        </p>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-md">
        <Stat label="Events" value={String(issue.count)} />
        <Stat label="Users" value={issue.userCount === undefined ? "—" : String(issue.userCount)} />
        <Stat label="First seen" value={formatDate(issue.firstSeen, "datetime")} />
        <Stat label="Last seen" value={formatDate(issue.lastSeen, "datetime")} />
      </dl>

      {Object.keys(tags).length > 0 && (
        <section aria-labelledby="tags-heading">
          <h2 id="tags-heading" className="text-sm font-semibold text-on-surface">Latest event</h2>
          <dl className="mt-xs grid grid-cols-1 sm:grid-cols-2 gap-x-md text-sm">
            {Object.entries(tags).map(([k, v]) => (
              <div key={k} className="flex gap-xs">
                <dt className="text-on-surface-variant">{k}</dt>
                <dd className="text-on-surface break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section aria-labelledby="trace-heading" className="space-y-sm">
        <h2 id="trace-heading" className="text-sm font-semibold text-on-surface">Exception</h2>
        {exception.length === 0 ? (
          <p className="text-sm text-on-surface-variant">The latest event carries no exception.</p>
        ) : (
          exception.map((e, i) => (
            <div key={i} className="rounded-2xl border border-outline-variant p-md">
              <p className="font-mono text-sm text-on-surface break-words">
                {e.type}: {e.value}
              </p>
              <ol className="mt-xs space-y-px font-mono text-xs text-on-surface-variant" aria-label="Stack frames, innermost first">
                {e.frames.map((f, j) => (
                  <li key={j} className="break-all">
                    {f.function} — {f.filename}
                    {f.line === null ? "" : `:${f.line}`}
                  </li>
                ))}
              </ol>
            </div>
          ))
        )}
      </section>

      <a href={issue.permalink} target="_blank" rel="noopener noreferrer" className="inline-block text-sm font-medium text-secondary hover:underline">
        Open in Sentry to resolve, ignore or assign ↗
      </a>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-lg">
      <Link href="/super-admin/system-health" className="text-sm text-secondary hover:underline">
        ← System Health
      </Link>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md">
      <dt className="text-xs uppercase tracking-wider text-outline">{label}</dt>
      <dd className="text-lg font-bold text-on-surface mt-xs">{value}</dd>
    </div>
  );
}
