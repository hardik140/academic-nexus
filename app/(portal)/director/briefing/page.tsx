"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/modal";
import { getExecutiveBriefing } from "./actions";

export default function ExecutiveBriefingPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    getExecutiveBriefing().then(setData);
  }, []);

  if (!data) {
    return <div className="p-xl text-center text-sm text-outline">Loading...</div>;
  }

  return (
    <div className="space-y-lg max-w-[52rem] print:max-w-none">
      <div className="flex items-start justify-between gap-md print:hidden">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Executive Briefing</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Generated {new Date(data.generatedAt).toLocaleString()}</p>
        </div>
        <Button variant="outline" onClick={() => window.print()}>
          🖨️ Print
        </Button>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-xl space-y-lg print:border-0 print:shadow-none">
        {/* Institutional Status */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Institutional Status</h2>
          {data.latestSnapshot?.overall_score != null ? (
            <p className="text-sm text-on-surface">
              Institution Health Score: <span className="font-extrabold">{data.latestSnapshot.overall_score}/100</span>
              {!data.hasComparison && " (first snapshot on record — no prior comparison yet)."}
            </p>
          ) : (
            <p className="text-sm text-outline italic">Insufficient data — no health-score snapshot available yet.</p>
          )}
        </section>

        {/* Positive Developments */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Top Positive Developments</h2>
          {data.positives.length > 0 ? (
            <ul className="text-sm text-on-surface space-y-xs list-disc list-inside">
              {data.positives.map((p: string, i: number) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-outline italic">No positive score movement since the last comparable snapshot.</p>
          )}
        </section>

        {/* Top Risks */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Top Risks</h2>
          {data.risks.length > 0 ? (
            <ul className="text-sm text-on-surface space-y-xs list-disc list-inside">
              {data.risks.map((r: string, i: number) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-outline italic">No critical institutional risks detected.</p>
          )}
        </section>

        {/* Decisions Waiting */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Decisions Waiting</h2>
          {data.decisionsWaiting.length > 0 ? (
            <ul className="text-sm text-on-surface space-y-xs">
              {data.decisionsWaiting.map((d: any) => (
                <li key={d.id}>
                  <Link href={`/director/decisions/${d.id}`} className="text-secondary hover:underline print:text-on-surface print:no-underline">
                    {d.title}
                  </Link>{" "}
                  <span className="text-xs text-outline">({d.urgency})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-outline italic">No decisions awaiting approval.</p>
          )}
        </section>

        {/* KPI Changes */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">KPI Changes</h2>
          {data.kpiChanges.length > 0 ? (
            <ul className="text-sm text-on-surface space-y-xs">
              {data.kpiChanges.map((c: any, i: number) => (
                <li key={i} className={c.delta > 0 ? "text-success" : "text-error"}>
                  {c.label}: {c.delta > 0 ? "+" : ""}
                  {c.delta} pts
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-outline italic">No comparable prior snapshot, or no material change.</p>
          )}
        </section>

        {/* Upcoming Deadlines */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Upcoming Deadlines</h2>
          {data.upcomingDeadlines.length > 0 ? (
            <ul className="text-sm text-on-surface space-y-xs">
              {data.upcomingDeadlines.map((d: any, i: number) => (
                <li key={i}>
                  {d.label} — {new Date(d.date).toLocaleDateString()}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-outline italic">No upcoming deadlines on record.</p>
          )}
        </section>

        {/* Escalations */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Escalations</h2>
          <p className="text-sm text-on-surface">
            {data.escalationsInProgress} escalation{data.escalationsInProgress === 1 ? "" : "s"} currently in the Attention Center.
          </p>
        </section>

        {/* Recommended Actions */}
        <section>
          <h2 className="text-sm font-bold text-on-surface uppercase tracking-wider mb-sm">Recommended Actions</h2>
          <ul className="text-sm text-on-surface space-y-xs list-disc list-inside">
            {data.recommendedActions.map((a: string, i: number) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
