"use client";

import { useEffect, useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { listWardenRooms } from "./actions";

const ROOMS_PAGE_SIZE = 10;

export default function WardenRooms() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<unknown>(null);
  const [totalRooms, setTotalRooms] = useState(0);
  const latestLoad = useRef(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadRooms(query); }, [query]);

  // The latest query's page; a failed load is an error in the table, never
  // "No rooms found" (owner decision D5).
  const loadRooms = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const { data, count } = await listWardenRooms(q);
      if (run !== latestLoad.current) return;
      setRooms(data);
      setTotalRooms(count);
    } catch (e) {
      if (run === latestLoad.current) setRoomsError(e);
    } finally {
      if (run === latestLoad.current) setRoomsLoading(false);
    }
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
                row.status === "available" ? "bg-success-container text-on-success-container" :
                row.status === "full" ? "bg-warning-container text-on-warning-container" : "bg-error-container text-on-error-container"
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
        error={roomsError}
        onRetry={() => loadRooms(query)}
        onQueryChange={setQuery}
        pageSize={ROOMS_PAGE_SIZE}
      />
    </div>
  );
}
