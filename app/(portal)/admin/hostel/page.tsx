"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { assignWarden } from "./actions";

export default function AdminHostel() {
  const supabase = createClient();
  const [blocks, setBlocks] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [editBlock, setEditBlock] = useState<any>(null);
  const [selectedWarden, setSelectedWarden] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadBlocks(); loadStaff(); }, []);

  const loadBlocks = async () => {
    const { data } = await supabase
      .from("hostel_blocks")
      .select("*, profiles:warden_id(full_name)")
      .order("name");
    setBlocks(data || []);
  };

  const loadStaff = async () => {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("role", "warden")
      .order("full_name");
    setStaff(data || []);
  };

  const openEdit = (block: any) => {
    setEditBlock(block);
    setSelectedWarden(block.warden_id || "");
    setError(null);
  };

  const handleAssignWarden = async () => {
    if (!editBlock) return;
    setLoading(true);
    setError(null);
    try {
      await assignWarden(editBlock.id, selectedWarden || null);
      setEditBlock(null);
      await loadBlocks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign warden.");
    } finally {
      setLoading(false);
    }
  };

  const wardenOptions = [
    { value: "", label: "— No warden assigned —" },
    ...staff.map((s) => ({ value: s.id, label: s.full_name })),
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Blocks</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Manage hostel blocks and assign wardens</p>
      </div>

      {error && !editBlock && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <DataTable
        columns={[
          { key: "name", header: "Block", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "type", header: "Type", render: (row: any) => <span className="capitalize">{row.type}</span> },
          { key: "total_rooms", header: "Total Rooms", render: (row: any) => row.total_rooms },
          { key: "floors", header: "Floors", render: (row: any) => row.floors },
          { key: "warden", header: "Warden", render: (row: any) => <span className="text-on-surface-variant">{(row.profiles as any)?.full_name || "— Unassigned —"}</span> },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={blocks}
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
            <Button onClick={handleAssignWarden} disabled={loading}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
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
