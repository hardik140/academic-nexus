import Link from "next/link";
import {
  listGates,
  listSecurityInstructions,
  listSecurityPersonnel,
  listUnauthorizedSecurityAccounts,
  securityOverview,
} from "./actions";
import { SecurityAdminClient } from "./security-admin-client";

export const dynamic = "force-dynamic";

/**
 * Director security administration (§11, §36).
 *
 * The tiles answer "is the gate under control right now"; everything below
 * them answers "who is allowed to control it". Both live here because a
 * Director looking at eleven students overdue is the same Director who
 * needs to see that only one guard is active tonight.
 */
export default async function DirectorSecurityPage() {
  const [overview, personnel, candidates, gates, instructions] = await Promise.all([
    securityOverview(),
    listSecurityPersonnel(),
    listUnauthorizedSecurityAccounts(),
    listGates(),
    listSecurityInstructions(),
  ]);

  const tiles = [
    { label: "Exits today", value: overview.exitsToday },
    { label: "Returns today", value: overview.returnsToday },
    { label: "Currently outside", value: overview.currentlyOutside },
    { label: "Overdue", value: overview.overdue, tone: overview.overdue > 0 ? "text-error" : undefined },
    { label: "Pending passes", value: overview.pendingPasses },
    { label: "Active guards", value: overview.activeGuards, tone: overview.activeGuards === 0 ? "text-error" : undefined },
    { label: "Active gates", value: overview.activeGates },
    {
      label: "Refused scans today",
      value: overview.rejectedScans,
      tone: overview.invalidQrAttempts > 0 ? "text-warning" : undefined,
      note: overview.invalidQrAttempts > 0 ? `${overview.invalidQrAttempts} unrecognised` : undefined,
    },
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-start justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Security</h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Who may operate a gate, which gate, and what is happening at them.
          </p>
        </div>
        <Link
          href="/director/security/movements"
          className="inline-flex items-center rounded-xl border border-outline-variant px-lg py-md text-sm font-semibold text-on-surface-variant hover:bg-surface-container-low"
        >
          Movement ledger
        </Link>
      </div>

      <div className="grid gap-md grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg">
            <div className="text-xs font-medium text-on-surface-variant">{t.label}</div>
            <div className={`text-3xl font-extrabold tabular-nums mt-xs ${t.tone ?? "text-on-surface"}`}>{t.value}</div>
            {t.note && <div className="text-xs text-outline mt-xs">{t.note}</div>}
          </div>
        ))}
      </div>

      <SecurityAdminClient
        personnel={personnel}
        candidates={candidates}
        gates={gates}
        instructions={instructions}
      />
    </div>
  );
}
