"use client";

import { useEffect, useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { listAuditLogs } from "./actions";

const LOGS_PAGE_SIZE = 10;

export default function AdminAuditLog() {
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<unknown>(null);
  const [totalLogs, setTotalLogs] = useState(0);
  const latestLoad = useRef(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadLogs(query); }, [query]);

  // The latest query's page; a failed load is an error in the table, never
  // an empty audit trail (owner decision D5).
  const loadLogs = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const { data, count } = await listAuditLogs(q);
      if (run !== latestLoad.current) return;
      setLogs(data);
      setTotalLogs(count);
    } catch (e) {
      if (run === latestLoad.current) setLogsError(e);
    } finally {
      if (run === latestLoad.current) setLogsLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Audit Log</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Complete audit trail of all system actions</p>
      </div>

      <DataTable
        title={`System Activity (${totalLogs} entries)`}
        columns={[
          {
            key: "created_at",
            header: "Timestamp",
            sortable: true,
            render: (row: any) => <span className="text-xs text-on-surface-variant font-mono">{new Date(row.created_at).toLocaleString()}</span>,
          },
          {
            key: "user",
            header: "User",
            render: (row: any) => (
              <div>
                <div className="text-sm font-medium text-on-surface">{(row.profiles as any)?.full_name || "System"}</div>
                <div className="text-[10px] text-outline">{(row.profiles as any)?.email}</div>
              </div>
            ),
          },
          {
            key: "role",
            header: "Role",
            render: (row: any) => (
              <span className="text-xs font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">{(row.profiles as any)?.role || "system"}</span>
            ),
          },
          { key: "action", header: "Action", render: (row: any) => <span className="font-medium text-on-surface">{row.action}</span> },
          { key: "table_name", header: "Table", render: (row: any) => <span className="text-on-surface-variant font-mono text-xs">{row.table_name}</span> },
          { key: "record_id", header: "Record", render: (row: any) => <span className="text-on-surface-variant text-xs font-mono">{row.record_id?.slice(0, 8) || "—"}</span> },
        ]}
        data={logs}
        keyExtractor={(row) => row.id}
        searchKey="action"
        searchPlaceholder="Search by user or action..."
        emptyMessage="No audit log entries recorded yet."
        serverMode
        totalCount={totalLogs}
        loading={logsLoading}
        error={logsError}
        onRetry={() => loadLogs(query)}
        onQueryChange={setQuery}
        pageSize={LOGS_PAGE_SIZE}
      />
    </div>
  );
}
