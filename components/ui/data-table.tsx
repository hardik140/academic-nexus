"use client";

import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

// ─── DataTable ───────────────────────────────────────────────────────

interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  className?: string;
}

export interface DataTableQuery {
  search: string;
  sortKey: string | null;
  sortDir: "asc" | "desc";
  page: number;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  searchPlaceholder?: string;
  searchKey?: string;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  actions?: (row: T) => React.ReactNode;
  title?: string;
  headerAction?: React.ReactNode;
  pageSize?: number;

  /**
   * Opt-in server-driven mode. Default (unset) keeps today's behavior:
   * `data` is the whole result set, filtered/sorted/paginated locally.
   *
   * When true, `data` is assumed to already be exactly one page's worth of
   * rows for the current query — DataTable stops touching it locally and
   * instead calls `onQueryChange` (debounced on search, same as before)
   * whenever search/sort/page changes, so the caller can run a real
   * `.range()` query. `totalCount` (not `data.length`) drives the page
   * count in this mode.
   */
  serverMode?: boolean;
  totalCount?: number;
  loading?: boolean;
  onQueryChange?: (query: DataTableQuery) => void;
}

export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  keyExtractor,
  searchPlaceholder = "Search...",
  searchKey,
  emptyMessage = "No records found.",
  onRowClick,
  actions,
  title,
  headerAction,
  pageSize = 10,
  serverMode = false,
  totalCount,
  loading = false,
  onQueryChange,
}: DataTableProps<T>) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Debounced separately from `searchInput` so the input itself stays
  // responsive to every keystroke while the (re-)filter/query + page reset
  // below only runs once typing pauses.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  // Server mode: report every query change (including the initial one on
  // mount) to the caller instead of filtering/sorting/paginating locally.
  // `onQueryChange` deliberately isn't a dependency — an inline callback
  // that's a new function identity every render must not re-trigger this,
  // only an actual search/sort/page change should.
  useEffect(() => {
    if (!serverMode) return;
    onQueryChange?.({ search, sortKey, sortDir, page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMode, search, sortKey, sortDir, page]);

  let paged: T[];
  let totalPages: number;
  let totalRows: number;

  if (serverMode) {
    paged = data;
    totalRows = totalCount ?? data.length;
    totalPages = Math.ceil(totalRows / pageSize);
  } else {
    let filtered = data;
    if (search && searchKey) {
      const q = search.toLowerCase();
      filtered = data.filter((row) =>
        String(row[searchKey] || "")
          .toLowerCase()
          .includes(q)
      );
    }

    if (sortKey) {
      filtered = [...filtered].sort((a, b) => {
        const va = a[sortKey] ?? "";
        const vb = b[sortKey] ?? "";
        if (va < vb) return sortDir === "asc" ? -1 : 1;
        if (va > vb) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
    }

    totalRows = filtered.length;
    totalPages = Math.ceil(totalRows / pageSize);
    paged = filtered.slice(page * pageSize, (page + 1) * pageSize);
  }

  const handleSort = (key: string) => {
    setPage(0);
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
      {/* Header */}
      {(title || searchKey || headerAction) && (
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between gap-md">
          {title && (
            <h2 className="text-sm font-bold text-on-surface shrink-0">
              {title}
            </h2>
          )}
          <div className="flex items-center gap-sm flex-1 justify-end">
            {searchKey && (
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full max-w-[20rem] bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
              />
            )}
            {headerAction}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-container-low text-on-surface-variant">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider",
                    col.sortable && "cursor-pointer select-none hover:text-on-surface",
                    col.className
                  )}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  <span className="flex items-center gap-xs">
                    {col.header}
                    {col.sortable && sortKey === col.key && (
                      <span className="text-secondary">
                        {sortDir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </span>
                </th>
              ))}
              {actions && (
                <th className="text-right px-lg py-sm font-semibold text-xs uppercase tracking-wider">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {loading ? (
              <tr>
                <td
                  colSpan={columns.length + (actions ? 1 : 0)}
                  className="px-lg py-xl text-center text-outline"
                >
                  Loading…
                </td>
              </tr>
            ) : paged.length > 0 ? (
              paged.map((row) => (
                <tr
                  key={keyExtractor(row)}
                  className={cn(
                    "hover:bg-surface-container-low transition-colors",
                    onRowClick && "cursor-pointer"
                  )}
                  onClick={() => onRowClick?.(row)}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn("px-lg py-md", col.className)}
                    >
                      {col.render
                        ? col.render(row)
                        : String(row[col.key] ?? "—")}
                    </td>
                  ))}
                  {actions && (
                    <td className="px-lg py-md text-right">{actions(row)}</td>
                  )}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={columns.length + (actions ? 1 : 0)}
                  className="px-lg py-xl text-center text-outline"
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-lg py-md border-t border-outline-variant flex items-center justify-between">
          <span className="text-xs text-outline">
            Showing {page * pageSize + 1}–
            {Math.min((page + 1) * pageSize, totalRows)} of{" "}
            {totalRows}
          </span>
          <div className="flex items-center gap-xs">
            <button
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="px-sm py-xs text-xs font-medium rounded-lg bg-surface-container-low hover:bg-surface-container-high disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const pageNum =
                totalPages <= 5
                  ? i
                  : Math.max(0, Math.min(page - 2, totalPages - 5)) + i;
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={cn(
                    "w-8 h-8 text-xs font-medium rounded-lg transition-colors",
                    page === pageNum
                      ? "bg-secondary text-on-secondary"
                      : "bg-surface-container-low hover:bg-surface-container-high text-on-surface-variant"
                  )}
                >
                  {pageNum + 1}
                </button>
              );
            })}
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
              className="px-sm py-xs text-xs font-medium rounded-lg bg-surface-container-low hover:bg-surface-container-high disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
