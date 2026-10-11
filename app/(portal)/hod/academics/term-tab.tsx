"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { DepartmentTermPanel } from "@/components/academics/department-term-panel";
import { ClassInchargeTable } from "@/components/academics/class-incharge-table";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { assignClassIncharge, endDepartmentTerm, getDepartmentOverview, startDepartmentTerm } from "./actions";

export function TermTab({ departmentId, departmentName }: { departmentId: string; departmentName: string }) {
  const overview = useAsyncResource(() => getDepartmentOverview(departmentId), [departmentId]);
  const [termPending, setTermPending] = useState(false);
  const [termError, setTermError] = useState<FeedbackError | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const runTerm = async (action: () => Promise<void>, done: string, fallback: string) => {
    setTermPending(true);
    setTermError(null);
    try {
      await action();
      setNotice(done);
      overview.reload();
      return true;
    } catch (e) {
      setTermError(await toFeedbackError(e, fallback));
      return false;
    } finally {
      setTermPending(false);
    }
  };

  const assign = async (sectionId: string, teacherId: string) => {
    setAssigning(sectionId);
    setAssignError(null);
    try {
      await assignClassIncharge(sectionId, teacherId);
      setNotice("Class In-Charge saved. The teacher has been notified.");
      overview.reload();
    } catch (e) {
      setAssignError(await toFeedbackError(e, "The Class In-Charge could not be saved."));
    } finally {
      setAssigning(null);
    }
  };

  return (
    <div className="space-y-lg">
      <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>
      <StateView state={overview} isEmpty={() => false} loadingLabel="Loading the department's term…" empty={{ title: "Nothing to show" }}>
        {(data) => (
          <>
            <DepartmentTermPanel
              departmentName={departmentName}
              readiness={data.readiness}
              pending={termPending}
              error={termError}
              onStart={(ack) => runTerm(() => startDepartmentTerm(departmentId, ack), "The department's term has started.", "The term could not be started.")}
              onEnd={(reason) => runTerm(() => endDepartmentTerm(departmentId, reason), "The department's term has ended. Its offerings are now read-only.", "The term could not be ended.")}
            />
            <section
              aria-labelledby="incharge-heading"
              className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
            >
              <div>
                <h2 id="incharge-heading" className="text-sm font-bold text-on-surface">Class In-Charges</h2>
                <p className="mt-xs text-sm text-on-surface-variant">
                  One per section for {data.readiness.semester_name ?? "the active term"}. Replacing one keeps the previous assignment in the history.
                </p>
              </div>
              <ErrorAlert error={assignError} />
              <ClassInchargeTable
                sections={data.sections}
                staff={data.staff}
                onAssign={(s, t) => void assign(s, t)}
                pendingSectionId={assigning}
                disabled={!data.readiness.semester_id}
              />
            </section>
          </>
        )}
      </StateView>
    </div>
  );
}
