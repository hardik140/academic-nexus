"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/modal";
import { classifyError } from "@/lib/feedback-error";

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

  /**
   * The load failed (M6.6, owner decision D5). With no rows, the table body
   * is an error with Try again instead of `emptyMessage` — a failed load is
   * never shown as "No records found". With rows from an earlier load, they
   * stay, under an error Alert. Anything truthy counts; only its code and
   * digest are used (see lib/feedback-error.ts), never its message.
   */
  error?: unknown;
  /** Try again after a failed load. */
  onRetry?: () => void;
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
  error,
  onRetry,
}: DataTableProps<T>) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const region = scrollRef.current;
    const table = region?.querySelector("table");
    if (!region || !table) return;
    // Observe viewport and content, including changes after data/font loads.
    // The observer also delivers the initial measurement without a layout shift.
    const observer = new ResizeObserver(() => {
      setHasOverflow(region.scrollWidth > region.clientWidth);
    });
    observer.observe(region);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

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
                className="w-full max-w-[20rem] bg-surface-container-low border border-border-control rounded-lg px-md py-xs text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none motion-feedback"
              />
            )}
            {headerAction}
          </div>
        </div>
      )}

      {/* Always rendered: the live region exists before its message. */}
      <Alert
        tone="error"
        className="mx-lg my-md"
        action={onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
      >
        {Boolean(error) && data.length > 0 ? "This couldn't be refreshed. Showing what was loaded earlier." : null}
      </Alert>

      {/* Table */}
      <div
        ref={scrollRef}
        className="overflow-x-auto focus-visible:outline-offset-[calc(-1*var(--focus-ring-width))]"
        tabIndex={hasOverflow ? 0 : -1}
        role={hasOverflow ? "region" : undefined}
        aria-label={hasOverflow ? (title || "Data") + " — scrollable table" : undefined}
        aria-busy={loading || undefined}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-container-low text-on-surface-variant">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={col.sortable ? (sortKey === col.key ? (sortDir === "asc" ? "ascending" : "descending") : "none") : undefined}
                  className={cn(
                    "text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider",
                    col.sortable && "relative cursor-pointer select-none hover:text-on-surface motion-feedback",
                    col.className
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className="flex items-center gap-xs w-full text-left uppercase tracking-[inherit] cursor-pointer before:absolute before:inset-0"
                      aria-label={"Sort by " + col.header}
                    >
                      {col.header}
                      {sortKey === col.key && (
                        <span aria-hidden="true" className="text-secondary">
                          {sortDir === "asc" ? "↑" : "↓"}
                        </span>
                      )}
                    </button>
                  ) : col.header}
                </th>
              ))}
              {actions && (
                <th scope="col" className="text-right px-lg py-sm font-semibold text-xs uppercase tracking-wider">
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
            ) : Boolean(error) && data.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (actions ? 1 : 0)}>
                  <ErrorState {...classifyError(error)} onRetry={onRetry} />
                </td>
              </tr>
            ) : paged.length > 0 ? (
              paged.map((row) => (
                <tr
                  key={keyExtractor(row)}
                  className={cn(
                    "hover:bg-surface-container-low motion-feedback",
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
              className="px-sm py-xs text-xs font-medium rounded-lg bg-surface-container-low hover:bg-surface-container-high disabled:opacity-40 motion-feedback"
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
                    "w-8 h-8 text-xs font-medium rounded-lg motion-feedback",
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
              className="px-sm py-xs text-xs font-medium rounded-lg bg-surface-container-low hover:bg-surface-container-high disabled:opacity-40 motion-feedback"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
