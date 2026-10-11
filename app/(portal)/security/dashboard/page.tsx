import Link from "next/link";
import { securityContext, securityOutsideNow, securityScanFeed, securityTodayCounts } from "../actions";
import { Alert } from "@/components/ui/alert";

/**
 * The guard's shift view.
 *
 * Everything here is operational: which gate, how many have gone out and
 * come back today, who is still outside and overdue, what the Director has
 * told them, and the last few scans. No institution analytics, no
 * per-student history, no anything that belongs on the Director's screen —
 * the guard's portal is small on purpose.
 */
export const dynamic = "force-dynamic";

function timeOf(value: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

export default async function SecurityDashboard() {
  const context = await securityContext();

  if (context.status !== "ACTIVE") {
    return (
      <div className="space-y-lg">
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Security</h1>
        <Alert tone="error">
          {context.status === null
            ? "This account has not been authorized for gate duty yet. The Director authorizes gate security accounts."
            : `Your gate security account is ${context.status.toLowerCase()}. You cannot operate a gate until it is reactivated.`}
        </Alert>
      </div>
    );
  }

  const primaryGate = context.gates[0];
  const [counts, feed, outside] = await Promise.all([
    primaryGate ? securityTodayCounts(primaryGate.id) : Promise.resolve({ out: 0, in: 0 }),
    primaryGate ? securityScanFeed(primaryGate.id, 10) : Promise.resolve([]),
    securityOutsideNow(),
  ]);

  const overdue = outside.filter((s) => s.overdue);

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Security</h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            {context.gates.length > 0
              ? `Assigned gate${context.gates.length > 1 ? "s" : ""}: ${context.gates.map((g) => g.name).join(", ")}`
              : "No gate assigned"}
            {context.employeeCode ? ` · ${context.employeeCode}` : ""}
          </p>
        </div>
        <Link
          href="/security/scanner"
          className="inline-flex items-center gap-xs rounded-xl bg-secondary text-on-secondary px-lg py-md text-sm font-semibold shadow-md"
        >
          Open scanner
        </Link>
      </div>

      <Alert tone="warning">
        {context.gates.length === 0 ? "You are active but not assigned to any gate. Ask the Director to assign one." : null}
      </Alert>

      {context.instructions.length > 0 && (
        <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Security instructions</h2>
          </div>
          <ul className="divide-y divide-outline-variant">
            {context.instructions.map((i) => (
              <li key={i.id} className="px-lg py-md">
                <div className="flex items-center gap-sm">
                  <span className="text-sm font-semibold text-on-surface">{i.title}</span>
                  {i.priority !== "normal" && (
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wide px-sm py-[2px] rounded-full ${
                        i.priority === "emergency" ? "bg-error/15 text-error" : "bg-warning/15 text-warning"
                      }`}
                    >
                      {i.priority}
                    </span>
                  )}
                </div>
                <p className="text-sm text-on-surface-variant mt-xs">{i.message}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-md sm:grid-cols-3">
        {[
          { label: "Exits today", value: counts.out, tone: "text-warning" },
          { label: "Returns today", value: counts.in, tone: "text-success" },
          { label: "Currently outside", value: outside.length, tone: "text-on-surface" },
        ].map((tile) => (
          <div key={tile.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg">
            <div className="text-xs font-medium text-on-surface-variant">{tile.label}</div>
            <div className={`text-3xl font-extrabold tabular-nums mt-xs ${tile.tone}`}>{tile.value}</div>
          </div>
        ))}
      </div>

      {overdue.length > 0 && (
        <section className="bg-error/5 border border-error/20 rounded-2xl">
          <div className="px-lg py-md border-b border-error/20">
            <h2 className="text-sm font-bold text-error">Overdue ({overdue.length})</h2>
          </div>
          <ul className="divide-y divide-error/10">
            {overdue.map((s) => (
              <li key={s.gate_pass_id} className="px-lg py-sm flex items-center gap-md">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface truncate">{s.student_name}</div>
                  <div className="text-xs text-outline truncate">
                    {s.enrollment_number} · {s.destination}
                  </div>
                </div>
                <div className="text-xs text-error font-semibold shrink-0 tabular-nums">
                  due {new Date(s.due_back).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-lg lg:grid-cols-2">
        <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Students outside ({outside.length})</h2>
          </div>
          <ul className="divide-y divide-outline-variant max-h-[24rem] overflow-y-auto">
            {outside.length === 0 && <li className="p-lg text-sm text-outline">Everyone is inside.</li>}
            {outside.map((s) => (
              <li key={s.gate_pass_id} className="px-lg py-sm flex items-center gap-md">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface truncate">{s.student_name}</div>
                  <div className="text-xs text-outline truncate">
                    {s.pass_code} · {s.destination}
                  </div>
                </div>
                <span className="text-xs text-outline tabular-nums shrink-0">out {timeOf(s.exited_at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">
              Recent scans{primaryGate ? ` — ${primaryGate.name}` : ""}
            </h2>
          </div>
          <ul className="divide-y divide-outline-variant max-h-[24rem] overflow-y-auto">
            {feed.length === 0 && <li className="p-lg text-sm text-outline">Nothing recorded here yet.</li>}
            {feed.map((m) => (
              <li key={m.movement_id} className="px-lg py-sm flex items-center gap-sm">
                <span
                  className={`text-xs font-bold px-sm py-[2px] rounded-full ${
                    m.movement_type === "OUT" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
                  }`}
                >
                  {m.movement_type}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface truncate">{m.student_name}</div>
                  <div className="text-xs text-outline truncate">
                    {m.pass_code}
                    {m.is_override && " · manual"}
                  </div>
                </div>
                <span className="text-xs text-outline tabular-nums shrink-0">{timeOf(m.occurred_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
