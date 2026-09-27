"use client";

import { useState } from "react";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { DataTable } from "@/components/ui/data-table";

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
