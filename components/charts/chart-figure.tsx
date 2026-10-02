import type { ReactNode } from "react";

/**
 * ChartFigure (Checkpoint 4, M7) — the one wrapper every chart renders through.
 *
 * - A <figure> named by its <figcaption>: a short summary of what the chart
 *   shows. The page's own heading stays the visible title, so the caption is
 *   for screen readers and the chart looks exactly as before.
 * - When the picture is a drawing, the values behind it as a table for screen
 *   readers, and the drawing itself hidden from assistive technology so its
 *   shapes and labels aren't read out piecemeal beside the table. A chart
 *   that is already an accessible table (the heatmap) passes
 *   `accessibleVisual` and stays exposed.
 * - Charts never animate. Recharts 3 has no global switch, so every series
 *   and Tooltip in components/charts sets isAnimationActive={false}, and every
 *   Recharts chart sets accessibilityLayer={false}: that layer makes the SVG a
 *   focusable, unnamed role="application", which can't sit inside the hidden
 *   drawing. tests/motion-contract.test.ts enforces both, and keeps Recharts
 *   inside components/charts.
 */

export interface ChartTable {
  columns: string[];
  /** One row per data point; the first cell names the row. */
  rows: Array<Array<string | number>>;
}

export function ChartFigure({
  caption,
  table,
  accessibleVisual = false,
  className,
  children,
}: {
  caption: string;
  table?: ChartTable;
  /** The visual is itself accessible (a real table with text values), so it is not hidden. */
  accessibleVisual?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={className}>
      <figcaption className="sr-only">{caption}</figcaption>
      <div aria-hidden={accessibleVisual ? undefined : true}>{children}</div>
      {table && (
        <table className="sr-only">
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map(([name, ...values], i) => (
              <tr key={i}>
                <th scope="row">{name}</th>
                {values.map((value, j) => (
                  <td key={j}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
