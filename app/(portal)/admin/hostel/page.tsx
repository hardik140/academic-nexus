"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import { assignWarden } from "./actions";

export default function AdminHostel() {
  const supabase = createClient();
  const [editBlock, setEditBlock] = useState<any>(null);
  const [selectedWarden, setSelectedWarden] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A failed load is an error in the table, never "No hostel blocks found." (D5).
  const blocksResource = useAsyncResource(
    async () => requireRows(await supabase.from("hostel_blocks").select("*, profiles:warden_id(full_name)").order("name")),
    []
  );
  const staffResource = useAsyncResource(
    async () => requireRows(await supabase.from("profiles").select("id, full_name, role").eq("role", "warden").order("full_name")),
    []
  );
  const staff: any[] = staffResource.data ?? [];

  const openEdit = (block: any) => {
    setEditBlock(block);
    setSelectedWarden(block.warden_id || "");
    setError(null);
  };

  const handleAssignWarden = async () => {
    if (!editBlock || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await assignWarden(editBlock.id, selectedWarden || null);
      const warden = staff.find((s) => s.id === selectedWarden);
      setNotice(warden ? `${warden.full_name} now wardens ${editBlock.name}.` : `${editBlock.name} no longer has a warden.`);
      setEditBlock(null);
      blocksResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to assign warden."));
    } finally {
      setLoading(false);
    }
  };

  const wardenOptions = [
    { value: "", label: "— No warden assigned —" },
    ...staff.map((s) => ({ value: s.id, label: s.full_name })),
  ];

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Blocks</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Manage hostel blocks and assign wardens</p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The assign dialog shows its own failure. */}
      <ErrorAlert error={!editBlock ? error : null} />

      <DataTable
        columns={[
          { key: "name", header: "Block", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "type", header: "Type", render: (row: any) => <span className="capitalize">{row.type}</span> },
          { key: "total_rooms", header: "Total Rooms", render: (row: any) => row.total_rooms },
          { key: "floors", header: "Floors", render: (row: any) => row.floors },
          { key: "warden", header: "Warden", render: (row: any) => <span className="text-on-surface-variant">{(row.profiles as any)?.full_name || "— Unassigned —"}</span> },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={(blocksResource.data as any[]) ?? []}
        loading={blocksResource.status === "loading" && !blocksResource.data}
        error={blocksResource.status === "error" ? blocksResource.error : undefined}
        onRetry={blocksResource.reload}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search blocks..."
        emptyMessage="No hostel blocks found."
        onRowClick={(row) => openEdit(row)}
        actions={(row: any) => (
          <button
            onClick={(e) => { e.stopPropagation(); openEdit(row); }}
            className="text-xs text-secondary hover:underline font-medium"
          >
            Assign Warden
          </button>
        )}
      />

      <Modal
        open={!!editBlock}
        onClose={() => setEditBlock(null)}
        title={`Assign Warden — ${editBlock?.name || ""}`}
        description="Only staff with the Warden role are eligible."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditBlock(null)}>Cancel</Button>
            <Button onClick={handleAssignWarden} disabled={loading || staffResource.status !== "success"} aria-busy={loading || undefined}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <Alert
          tone="error"
          className="mb-md"
          action={<Button variant="outline" size="sm" onClick={staffResource.reload}>Try again</Button>}
        >
          {staffResource.status === "error" ? (
            <>
              Wardens couldn&apos;t be loaded, so one can&apos;t be chosen yet.
            </>
          ) : null}
        </Alert>
        <FormField
          label="Warden"
          id="edit_warden"
          type="select"
          value={selectedWarden}
          onChange={setSelectedWarden}
          options={wardenOptions}
        />
      </Modal>
    </div>
  );
}
