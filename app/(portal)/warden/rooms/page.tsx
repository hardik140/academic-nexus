"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";

export default function WardenRooms() {
  const supabase = createClient();
  const [rooms, setRooms] = useState<any[]>([]);

  useEffect(() => { loadRooms(); }, []);

  const loadRooms = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: blocks } = await supabase.from("hostel_blocks").select("id").eq("warden_id", user.id);
    const blockIds = (blocks || []).map((b) => b.id);
    if (blockIds.length === 0) { setRooms([]); return; }
    const { data } = await supabase.from("hostel_rooms").select("*").in("block_id", blockIds).order("block_name").order("room_number");
    setRooms(data || []);
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Rooms</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Room occupancy across your managed blocks</p>
      </div>

      <DataTable
        columns={[
          { key: "block_name", header: "Block", sortable: true },
          { key: "room_number", header: "Room #", sortable: true },
          { key: "type", header: "Category", sortable: true, render: (row: any) => <span className="capitalize">{row.type}</span> },
          { key: "ac", header: "AC", render: (row: any) => (row.ac ? "❄️ Yes" : "No") },
          {
            key: "occupancy",
            header: "Occupancy",
            sortable: true,
            render: (row: any) => (
              <span className={row.occupancy >= row.capacity ? "text-error font-semibold" : "text-on-surface"}>
                {row.occupancy}/{row.capacity}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (row: any) => (
              <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                row.status === "available" ? "bg-success/10 text-success" :
                row.status === "full" ? "bg-warning/10 text-warning" : "bg-error/10 text-error"
              }`}>{row.status}</span>
            ),
          },
        ]}
        data={rooms}
        keyExtractor={(row) => row.id}
        searchKey="room_number"
        searchPlaceholder="Search by block or room #..."
        emptyMessage="No rooms found for your managed blocks."
      />
    </div>
  );
}
