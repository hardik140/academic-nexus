"use client";

import { useRef, useState } from "react";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { DataTable } from "@/components/ui/data-table";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { cn } from "@/lib/utils";

// Interactive halves of the development-only component gallery. Imported only
// by app/dev/gallery/page.dev.tsx, which is not a route outside `next dev`
// (see next.config.ts), so nothing here is bundled into a built deployment.
// All data is fictional sample data; nothing is fetched.

type SampleRow = {
  id: string;
  enrollment: string;
  name: string;
  programme: string;
  amount: number;
  status: string;
};

const SAMPLE_ROWS: SampleRow[] = [
  { id: "1", enrollment: "22CS041", name: "Asha Rao", programme: "B.Tech CSE", amount: 12500, status: "pending" },
  { id: "2", enrollment: "22CS017", name: "Vikram Nair", programme: "B.Tech CSE", amount: 48000, status: "paid" },
  { id: "3", enrollment: "22EC102", name: "Meera Iyer", programme: "B.Tech ECE", amount: 0, status: "overdue" },
  { id: "4", enrollment: "22ME009", name: "Rohan Gupta", programme: "B.Tech ME", amount: 7250, status: "partial" },
  { id: "5", enrollment: "22CS088", name: "Fatima Sheikh", programme: "B.Tech CSE", amount: 31000, status: "paid" },
  { id: "6", enrollment: "22EC044", name: "Arjun Menon", programme: "B.Tech ECE", amount: 15000, status: "pending" },
];

const COLUMNS = [
  { key: "enrollment", header: "Enrollment", sortable: true },
  { key: "name", header: "Student", sortable: true },
  { key: "programme", header: "Programme" },
  { key: "amount", header: "Amount", sortable: true, render: (r: SampleRow) => r.amount.toLocaleString("en-IN") },
  { key: "status", header: "Status" },
];

export function DataTableDemos() {
  return (
    <div className="space-y-lg">
      <DataTable
        title="Client-mode table (sortable, searchable, paginated)"
        columns={COLUMNS}
        data={SAMPLE_ROWS}
        keyExtractor={(r) => r.id}
        searchKey="name"
        searchPlaceholder="Search by name..."
        pageSize={4}
      />
      <DataTable title="Empty table" columns={COLUMNS} data={[]} keyExtractor={(r) => r.id} emptyMessage="No records found." />
      <DataTable title="Loading table (server mode)" columns={COLUMNS} data={[]} keyExtractor={(r) => r.id} serverMode loading totalCount={0} />
    </div>
  );
}

export function FormFieldDemos() {
  const [text, setText] = useState("");
  const [select, setSelect] = useState("");
  const [area, setArea] = useState("");
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
      <FormField label="Text field" id="g-text" value={text} onChange={setText} placeholder="Placeholder text" />
      <FormField label="Required field" id="g-required" value="" onChange={() => {}} required />
      <FormField
        label="Select field"
        id="g-select"
        type="select"
        value={select}
        onChange={setSelect}
        options={[
          { value: "present", label: "Present" },
          { value: "absent", label: "Absent" },
        ]}
      />
      <FormField label="Field with error" id="g-error" value="not-an-email" onChange={() => {}} error="Enter a valid email address." />
      <FormField label="Disabled field" id="g-disabled" value="Read-only value" onChange={() => {}} disabled />
      <FormField label="Textarea" id="g-textarea" type="textarea" value={area} onChange={setArea} rows={3} placeholder="Reason..." />
    </div>
  );
}

/** Browser check for Button's default type: only an explicit submit submits. */
export function ButtonFormDemo() {
  const [submits, setSubmits] = useState(0);
  return (
    <form
      aria-label="Button form behaviour"
      onSubmit={(e) => {
        e.preventDefault();
        setSubmits((n) => n + 1);
      }}
      className="flex flex-wrap items-center gap-sm"
    >
      <Button variant="outline">Untyped button</Button>
      <Button type="submit">Explicit submit</Button>
      <span className="text-sm text-on-surface" data-testid="submit-count">
        Submissions: {submits}
      </span>
    </form>
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SampleRequest = { id: number; label: string; delayMs: number; fail: boolean };

/**
 * Browser check for useAsyncResource: loading → success, loading → error,
 * reload, and a slow request overtaken by a fast one (the slow result must
 * never land). Data is fabricated by a timer; nothing is fetched.
 */
export function AsyncResourceDemo() {
  const [request, setRequest] = useState<SampleRequest>({ id: 0, label: "initial", delayMs: 300, fail: false });
  const resource = useAsyncResource(async () => {
    await wait(request.delayMs);
    if (request.fail) throw new Error("Sample failure");
    return request.label;
  }, [request.id]);

  const next = (label: string, delayMs: number, fail = false) =>
    setRequest((r) => ({ id: r.id + 1, label, delayMs, fail }));

  return (
    <div className="space-y-sm">
      <div className="flex flex-wrap gap-sm">
        <Button variant="outline" onClick={() => next("loaded", 300)}>Load (succeeds)</Button>
        <Button variant="outline" onClick={() => next("never", 300, true)}>Load (fails)</Button>
        <Button variant="outline" onClick={() => resource.reload()}>Reload</Button>
        <Button
          variant="outline"
          onClick={() => {
            next("slow", 1200);
            setTimeout(() => next("fast", 100), 50);
          }}
        >
          Slow then fast
        </Button>
      </div>
      <p className="text-sm text-on-surface" role="status">
        Status: <span data-testid="resource-status">{resource.status}</span> · Data:{" "}
        <span data-testid="resource-data">{resource.data ?? "none"}</span>
        {resource.status === "error" && <> · Error: {resource.error instanceof Error ? resource.error.message : "unknown"}</>}
      </p>
    </div>
  );
}

export function ModalDemo() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Sample modal"
        description="The current Modal primitive, unchanged."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => setOpen(false)}>Confirm</Button>
          </>
        }
      >
        <FormField label="Reason" id="g-modal-reason" type="textarea" value={reason} onChange={setReason} required />
      </Modal>
    </>
  );
}

/**
 * Browser checks for the four motion utilities (Checkpoint 4, M1). These are
 * bare elements carrying each utility — deliberately not the future Dialog
 * or Drawer components — so Playwright can read the computed transitions,
 * watch a native <dialog> enter and leave, and repeat it all with reduced
 * motion requested.
 */
export function MotionUtilityDemos() {
  const [approved, setApproved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);

  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center gap-sm">
        <button
          type="button"
          data-testid="motion-feedback-demo"
          className="motion-feedback rounded-control border border-border-control bg-surface-container-lowest px-md py-sm text-body text-on-surface hover:bg-surface-container-high"
        >
          motion-feedback
        </button>

        <button
          type="button"
          onClick={() => setApproved((a) => !a)}
          className="motion-feedback rounded-control border border-border-control bg-surface-container-lowest px-md py-sm text-body text-on-surface hover:bg-surface-container-high"
        >
          Toggle state
        </button>
        <span
          data-testid="motion-state-demo"
          className={cn(
            "motion-state inline-flex rounded-full px-sm py-xs text-caption font-semibold",
            approved ? "bg-success-container text-on-success-container" : "bg-warning-container text-on-warning-container",
          )}
        >
          {approved ? "Approved" : "Pending"}
        </span>

        <button
          type="button"
          onClick={() => dialogRef.current?.showModal()}
          className="motion-feedback rounded-control border border-border-control bg-surface-container-lowest px-md py-sm text-body text-on-surface hover:bg-surface-container-high"
        >
          Open motion-dialog
        </button>
        <button
          type="button"
          onClick={() => drawerRef.current?.showModal()}
          className="motion-feedback rounded-control border border-border-control bg-surface-container-lowest px-md py-sm text-body text-on-surface hover:bg-surface-container-high"
        >
          Open motion-drawer
        </button>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="motion-dialog-title"
        data-testid="motion-dialog-demo"
        className="motion-dialog m-auto w-[min(28rem,calc(100%-2rem))] rounded-dialog border border-outline-variant bg-surface-container-lowest p-lg text-on-surface shadow-dialog backdrop:bg-black/40"
      >
        <h3 id="motion-dialog-title" className="text-section">motion-dialog</h3>
        <p className="mt-xs text-body-sm text-on-surface-variant">A bare native dialog carrying the utility: 200ms in, 150ms out.</p>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="motion-feedback mt-md rounded-control border border-border-control px-md py-sm text-body hover:bg-surface-container-high"
        >
          Close
        </button>
      </dialog>

      <dialog
        ref={drawerRef}
        aria-labelledby="motion-drawer-title"
        data-testid="motion-drawer-demo"
        className="motion-drawer m-0 h-dvh max-h-dvh w-[min(18rem,85vw)] border-r border-outline-variant bg-surface-container-lowest p-lg text-on-surface backdrop:bg-black/40"
      >
        <h3 id="motion-drawer-title" className="text-section">motion-drawer</h3>
        <p className="mt-xs text-body-sm text-on-surface-variant">A bare native dialog carrying the utility: 300ms in, 200ms out.</p>
        <button
          type="button"
          onClick={() => drawerRef.current?.close()}
          className="motion-feedback mt-md rounded-control border border-border-control px-md py-sm text-body hover:bg-surface-container-high"
        >
          Close
        </button>
      </dialog>
    </div>
  );
}

/**
 * Browser check for StatusBadge's motion-state (M2): the badge only
 * transitions when its status actually changes — never on first render.
 */
export function StatusChangeDemo() {
  const [status, setStatus] = useState("pending");
  return (
    <div className="flex flex-wrap items-center gap-sm">
      <Button variant="outline" onClick={() => setStatus((s) => (s === "pending" ? "approved" : "pending"))}>
        Change status
      </Button>
      <span data-testid="status-change">
        <StatusBadge status={status} />
      </span>
    </div>
  );
}
