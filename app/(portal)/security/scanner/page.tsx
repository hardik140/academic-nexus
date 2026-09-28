import { securityContext } from "../actions";
import { ScannerClient } from "./scanner-client";

/**
 * The scanner is the guard's whole job, so it loads with as little around
 * it as possible: the gates they may operate, and the scanner. No KPI
 * strip, no charts, nothing that has to be fetched before the first student
 * can be let out.
 */
export default async function SecurityScannerPage() {
  const context = await securityContext();

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Scanner</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Scan the student&apos;s gate pass. The server decides whether it is an exit or a return.
        </p>
      </div>

      {context.status !== "ACTIVE" ? (
        <div className="bg-error/10 border border-error/20 text-error rounded-2xl p-lg text-sm font-medium">
          {context.status === null
            ? "This account has not been authorized for gate duty yet."
            : `Your gate security account is ${context.status.toLowerCase()}. You cannot record movements.`}
        </div>
      ) : !context.permissions.includes("gate_security.scanner.use") ? (
        <div className="bg-error/10 border border-error/20 text-error rounded-2xl p-lg text-sm font-medium">
          Your account does not have the scanner permission.
        </div>
      ) : (
        <ScannerClient gates={context.gates} />
      )}
    </div>
  );
}
