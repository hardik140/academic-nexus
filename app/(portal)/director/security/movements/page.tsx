import Link from "next/link";
import { listGateMovements, listSecurityAuditEvents } from "../actions";

export const dynamic = "force-dynamic";

/**
 * The movement ledger and the security audit, side by side (§30, §38).
 *
 * Two different records, deliberately not merged: the ledger is what
 * physically happened, the audit is every attempt — including the ones that
 * were refused, which by definition left no ledger row. An investigation
 * needs both, and a screen that showed only the first would make a night of
 * rejected scans look like a quiet night.
 */
function meta(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.movement_type === "string") parts.push(String(obj.movement_type));
  if (typeof obj.reason === "string") parts.push(String(obj.reason));
  if (typeof obj.gate_id === "string") parts.push("gate set");
  if (typeof obj.fingerprint === "string") parts.push(`fp ${obj.fingerprint}`);
  if (typeof obj.pass_status === "string") parts.push(`pass ${obj.pass_status}`);
  if (typeof obj.credential_status === "string") parts.push(`credential ${obj.credential_status}`);
  return parts.join(" · ");
}

export default async function DirectorMovementsPage() {
  const [movements, events] = await Promise.all([listGateMovements(150), listSecurityAuditEvents(150)]);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-start justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Movement Ledger</h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Every crossing, and every attempt at one. Neither record can be edited.
          </p>
        </div>
        <Link
          href="/director/security"
          className="inline-flex items-center rounded-xl border border-outline-variant px-lg py-md text-sm font-semibold text-on-surface-variant hover:bg-surface-container-low"
        >
          Back to security
        </Link>
      </div>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Movements ({movements.length})</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-on-surface-variant">
              <tr className="border-b border-outline-variant">
                <th className="text-left font-medium px-lg py-sm">When</th>
                <th className="text-left font-medium px-lg py-sm">Direction</th>
                <th className="text-left font-medium px-lg py-sm">Student</th>
                <th className="text-left font-medium px-lg py-sm">Pass</th>
                <th className="text-left font-medium px-lg py-sm">Gate</th>
                <th className="text-left font-medium px-lg py-sm">Recorded by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {movements.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-lg py-xl text-center text-outline">
                    No movements recorded yet.
                  </td>
                </tr>
              )}
              {movements.map((m) => (
                <tr key={m.id} className="hover:bg-surface-container-low">
                  <td className="px-lg py-sm whitespace-nowrap tabular-nums text-on-surface-variant">
                    {new Date(m.occurred_at).toLocaleString()}
                  </td>
                  <td className="px-lg py-sm">
                    <span
                      className={`text-xs font-bold px-sm py-[2px] rounded-full ${
                        m.movement_type === "OUT" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
                      }`}
                    >
                      {m.movement_type}
                    </span>
                  </td>
                  <td className="px-lg py-sm">
                    <div className="font-semibold text-on-surface">{m.student_name}</div>
                    <div className="text-xs text-outline">{m.enrollment_number}</div>
                  </td>
                  <td className="px-lg py-sm">
                    <div className="text-on-surface">{m.pass_code}</div>
                    <div className="text-xs text-outline">{m.destination}</div>
                  </td>
                  <td className="px-lg py-sm text-on-surface-variant">{m.gate_name}</td>
                  <td className="px-lg py-sm">
                    <div className="text-on-surface">{m.recorded_by_name}</div>
                    <div className="text-xs text-outline">
                      {m.recorded_role}
                      {m.is_override && " · manual"}
                    </div>
                    {m.override_reason && (
                      <div className="text-xs text-warning mt-xs max-w-[22rem]">{m.override_reason}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Security audit ({events.length})</h2>
        </div>
        <ul className="divide-y divide-outline-variant max-h-[36rem] overflow-y-auto">
          {events.length === 0 && <li className="p-xl text-center text-sm text-outline">No security events yet.</li>}
          {events.map((e) => {
            const refused = e.action.startsWith("gate_scan_");
            return (
              <li key={e.id} className="px-lg py-sm flex items-start gap-md">
                <span className={`text-xs font-semibold shrink-0 ${refused ? "text-warning" : "text-on-surface-variant"}`}>
                  {e.action.replace(/_/g, " ")}
                </span>
                <div className="min-w-0 flex-1 text-xs text-outline">
                  <span className="text-on-surface-variant">{e.actor_name}</span>
                  {meta(e.new_value) && <> · {meta(e.new_value)}</>}
                </div>
                <span className="text-xs text-outline tabular-nums shrink-0">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
