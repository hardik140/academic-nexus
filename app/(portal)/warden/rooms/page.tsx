"use client";

import { useState, useEffect } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { listWardenRooms } from "./actions";

const ROOMS_PAGE_SIZE = 10;

export default function WardenRooms() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [totalRooms, setTotalRooms] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadRooms(query); }, [query]);

  const loadRooms = async (q: DataTableQuery) => {
    setRoomsLoading(true);
    const { data, count } = await listWardenRooms(q);
    setRooms(data);
    setTotalRooms(count);
    setRoomsLoading(false);
  };

  return (
    <div className="space-y-lg">
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
        serverMode
        totalCount={totalRooms}
        loading={roomsLoading}
        onQueryChange={setQuery}
        pageSize={ROOMS_PAGE_SIZE}
      />
    </div>
  );
}
