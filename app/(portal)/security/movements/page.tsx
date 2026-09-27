import { securityContext, securityScanFeed } from "../actions";

export const dynamic = "force-dynamic";

/**
 * The guard's own movement history, gate by gate.
 *
 * Scoped by security_scan_feed(), which refuses a gate the caller does not
 * operate and requires the movement.view capability — so this page cannot
 * be widened by editing it, only by the Director assigning another gate.
 */
export default async function SecurityMovementsPage() {
  const context = await securityContext();

  if (context.status !== "ACTIVE") {
    return (
      <div className="space-y-lg">
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Movements</h1>
        <div className="bg-error/10 border border-error/20 text-error rounded-2xl p-lg text-sm font-medium">
          This account is not active for gate duty.
        </div>
      </div>
    );
  }

  const feeds = await Promise.all(
    context.gates.map(async (g) => ({ gate: g, rows: await securityScanFeed(g.id, 100) }))
  );

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Movements</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Recorded crossings at the gates you operate. This record cannot be edited.
        </p>
      </div>

      {feeds.length === 0 && (
        <div className="bg-warning/10 border border-warning/20 text-warning rounded-2xl p-lg text-sm font-medium">
          You are not assigned to a gate.
        </div>
      )}

      {feeds.map(({ gate, rows }) => (
        <section key={gate.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">
              {gate.code} — {gate.name} ({rows.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-on-surface-variant">
                <tr className="border-b border-outline-variant">
                  <th className="text-left font-medium px-lg py-sm">When</th>
                  <th className="text-left font-medium px-lg py-sm">Direction</th>
                  <th className="text-left font-medium px-lg py-sm">Student</th>
                  <th className="text-left font-medium px-lg py-sm">Pass</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-lg py-xl text-center text-outline">
                      Nothing recorded at this gate yet.
                    </td>
                  </tr>
                )}
                {rows.map((m) => (
                  <tr key={m.movement_id} className="hover:bg-surface-container-low">
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
                      <div className="text-xs text-outline">
                        {m.destination}
                        {m.is_override && " · manual"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
