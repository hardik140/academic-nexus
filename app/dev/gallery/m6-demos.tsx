"use client";

import { useRef, useState } from "react";
import { Button, FormField, Modal } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { DataTable } from "@/components/ui/data-table";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { RequestDecision } from "@/components/portal/request-decision";
import type { FeedbackError } from "@/lib/action-failure";

// M6 demos for the development-only component gallery: the toast, the
// confirmation dialog, request-decision, field validation, DataTable's error
// state and session expiry. Imported only by app/dev/gallery/page.dev.tsx,
// which is not a route outside `next dev`. All data is fictional; nothing is
// fetched and no Server Action is called — each "action" is a timer.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure as toFeedbackError() would report it, without asking Supabase. */
const failure = (message: string, session = false): FeedbackError => ({ message, session });

// ─── Toast ───────────────────────────────────────────────────────────────

function ToastControls() {
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const count = useRef(0);
  return (
    <div className="space-y-sm" data-testid="toast-demo">
      <div className="flex flex-wrap gap-sm">
        <Button variant="outline" onClick={() => toast.success("Invitation resent to asha@example.edu.")}>
          Show success toast
        </Button>
        <Button variant="outline" onClick={() => toast.info("Timetable for Semester 6 is now published.")}>
          Show info toast
        </Button>
        <Button variant="outline" onClick={() => toast.success("Invitation resent to rohan@example.edu.", { id: "resend-rohan" })}>
          Show toast with id
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            for (let i = 0; i < 4; i++) toast.info(`Sample notice ${++count.current}.`);
          }}
        >
          Show four toasts
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setDialogOpen(true);
            setTimeout(() => toast.success("Saved while the dialog was open."), 500);
          }}
        >
          Open dialog, toast after 0.5s
        </Button>
      </div>
      <Modal open={dialogOpen} onClose={() => setDialogOpen(false)} title="A dialog over the page">
        <p className="text-body text-on-surface">A toast raised now waits until this dialog closes.</p>
      </Modal>
    </div>
  );
}

export function ToastDemos() {
  return (
    <ToastProvider>
      <ToastControls />
    </ToastProvider>
  );
}

// ─── ConfirmationDialog ──────────────────────────────────────────────────

const INVITATIONS = [
  { id: "inv-1", email: "meera.iyer@example.edu" },
  { id: "inv-2", email: "kabir.shah@example.edu" },
];

export function ConfirmationDemos() {
  const [rows, setRows] = useState(INVITATIONS);
  const [target, setTarget] = useState<{ id: string; email: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failNext, setFailNext] = useState(false);
  const [calls, setCalls] = useState(0);
  const noticeRef = useRef<HTMLDivElement>(null);

  const confirm = async () => {
    if (!target) return;
    setCalls((n) => n + 1);
    setPending(true);
    setError(null);
    // Long enough for a test to try closing it while it runs.
    await wait(1500);
    if (failNext) {
      setError(failure("The invitation could not be revoked. Try again."));
      setFailNext(false);
      setPending(false);
      return;
    }
    setNotice(`Invitation for ${target.email} revoked.`);
    setTarget(null);
    setPending(false);
    // The row goes away after the dialog closes, as a real list reload does.
    const id = target.id;
    setTimeout(() => setRows((r) => r.filter((x) => x.id !== id)), 100);
  };

  return (
    <div className="space-y-sm" data-testid="confirm-demo">
      <label className="flex items-center gap-xs text-body-sm text-on-surface">
        <input type="checkbox" checked={failNext} onChange={(e) => setFailNext(e.target.checked)} />
        Next confirmation fails
      </label>
      <p className="text-body-sm text-on-surface-variant" data-testid="confirm-calls">
        Confirmations sent: {calls}
      </p>
      <div ref={noticeRef}>
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      </div>
      <ul className="divide-y divide-outline-variant rounded-panel border border-outline-variant">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-sm px-md py-sm text-body text-on-surface">
            <span className="min-w-0 break-all">{r.email}</span>
            <Button variant="outline" size="sm" onClick={() => { setError(null); setTarget(r); }}>
              Revoke {r.email}
            </Button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-md py-sm text-body-sm text-on-surface-variant">No pending invitations.</li>}
      </ul>
      <ConfirmationDialog
        open={!!target}
        title="Revoke this invitation?"
        description={target ? `${target.email} will no longer be able to use the invitation link.` : undefined}
        confirmLabel="Revoke invitation"
        pendingLabel="Revoking…"
        pending={pending}
        error={error}
        onConfirm={confirm}
        onCancel={() => setTarget(null)}
        returnFocusTo={() => noticeRef.current?.querySelector<HTMLElement>('[role="status"]') ?? null}
      />
    </div>
  );
}

// ─── Request-decision ────────────────────────────────────────────────────

type NextOutcome = "succeed" | "network" | "action";

export function RequestDecisionDemo() {
  const [calls, setCalls] = useState(0);
  const [outcome, setOutcome] = useState<NextOutcome>("succeed");
  return (
    <div className="space-y-sm" data-testid="request-decision-demo">
      <label className="flex flex-wrap items-center gap-xs text-body-sm text-on-surface">
        Next request
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as NextOutcome)}
          className="rounded-control border border-border-control bg-surface-container-lowest px-sm py-xs text-body-sm text-on-surface"
        >
          <option value="succeed">succeeds</option>
          <option value="network">fails at the network</option>
          {/* A Server Action throws with no code; with no session here, the
              direct session check (D11 fallback) reports the session ended. */}
          <option value="action">fails as a Server Action</option>
        </select>
      </label>
      <p className="text-body-sm text-on-surface-variant" data-testid="request-decision-calls">
        Requests sent: {calls}
      </p>
      <div className="flex justify-end">
        <RequestDecision
          onSubmit={async () => {
            setCalls((n) => n + 1);
            await wait(600);
            const result = outcome;
            if (result !== "succeed") setOutcome("succeed");
            if (result === "network") throw new TypeError("Failed to fetch");
            if (result === "action") throw new Error("An error occurred in the Server Components render.");
            return { id: "decision-demo" };
          }}
        />
      </div>
    </div>
  );
}

// ─── FormField validation ────────────────────────────────────────────────

export function FieldValidationDemo() {
  const [form, setForm] = useState({ title: "", reason: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    if (!form.title.trim()) missing["val-title"] = "Enter a title.";
    if (!form.reason.trim()) missing["val-reason"] = "Give a reason.";
    setFieldErrors(missing);
    const first = Object.keys(missing)[0];
    if (first) {
      setSaved(null);
      setError("Fill in the highlighted fields to continue.");
      document.getElementById(first)?.focus();
      return;
    }
    setError(null);
    setSaved(`"${form.title}" saved.`);
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Validation demo" className="max-w-md space-y-md" data-testid="validation-demo">
      <ErrorAlert error={error} />
      <Alert tone="success" onDismiss={() => setSaved(null)}>
        {saved}
      </Alert>
      <FormField label="Title" id="val-title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required error={fieldErrors["val-title"]} />
      <FormField label="Reason" id="val-reason" type="textarea" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} required error={fieldErrors["val-reason"]} />
      <Button type="submit">Save</Button>
    </form>
  );
}

// ─── DataTable error ─────────────────────────────────────────────────────

type Row = { id: string; name: string; programme: string };
const TABLE_ROWS: Row[] = [
  { id: "1", name: "Asha Rao", programme: "B.Tech CSE" },
  { id: "2", name: "Rohan Mehta", programme: "B.Com" },
];

export function DataTableErrorDemo() {
  const [data, setData] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempts = useRef(0);

  const load = async (mode: "fail-once" | "fail" | "ok") => {
    setLoading(true);
    setError(null);
    await wait(400);
    attempts.current += 1;
    if (mode === "fail" || (mode === "fail-once" && attempts.current === 1)) {
      setError(new Error("Sample failure"));
    } else {
      setData(TABLE_ROWS);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-sm" data-testid="table-error-demo">
      <div className="flex flex-wrap gap-sm">
        <Button variant="outline" onClick={() => { attempts.current = 0; setData([]); void load("fail-once"); }}>
          Table: fail first load
        </Button>
        <Button variant="outline" onClick={() => void load("fail")}>
          Table: fail a refresh
        </Button>
      </div>
      <DataTable
        columns={[
          { key: "name", header: "Student" },
          { key: "programme", header: "Programme" },
        ]}
        data={data}
        keyExtractor={(r) => r.id}
        emptyMessage="No students found."
        loading={loading}
        error={error}
        onRetry={() => void load("ok")}
      />
    </div>
  );
}

// ─── Session expiry ──────────────────────────────────────────────────────

export function SessionDemos() {
  return (
    <div className="grid gap-md md:grid-cols-2" data-testid="session-demo">
      <div className="rounded-panel border border-outline-variant bg-surface-container-lowest">
        <ErrorState kind="session" />
      </div>
      <ErrorAlert error={failure("Your session has expired. Please sign in again.", true)} />
    </div>
  );
}
