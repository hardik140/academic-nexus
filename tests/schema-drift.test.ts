import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Static guard against the defect class that migration 047 creates: code that
 * still reads a column the migration drops.
 *
 * WHY A STATIC CHECK AND NOT A RUNTIME ONE
 *
 * TypeScript cannot see it. PostgREST select strings are string literals, and
 * the embedded-join syntax (`courses:course_id(name)`) is opaque to the
 * client's generated types — which are hand-maintained here in any case. So a
 * query naming a dropped column compiles cleanly, passes review, and fails at
 * runtime against the migrated database as an empty result or an error,
 * depending on the shape.
 *
 * That is not hypothetical. The Phase 8 migration audit reported zero
 * remaining consumers, and it was wrong: it searched for
 * `courses.instructor_id` and for `courseId` identifiers, not for every column
 * 047 drops on every table. Six files were still reading dropped columns,
 * including actOnAttendanceCorrectionCore — the HOD approval path for
 * attendance corrections. The RLS suite did not catch them either, because it
 * tests policies with SQL rather than executing the Server Actions.
 *
 * This test is the thing that would have caught them, so it exists now.
 *
 * HOW IT WORKS
 *
 * For each source file it tracks the most recent `.from("table")` and flags a
 * reference to one of that table's dropped columns within the following few
 * lines. Embedded joins that legitimately reach a column on ANOTHER table
 * (`course_offerings:offering_id(courses:course_id(...))` — course_id there
 * belongs to course_offerings, which keeps it) are excluded by requiring the
 * dropped column to appear as a filter argument or a property access on the
 * row, not as part of a nested embed.
 */

const DROPPED_BY_047: Record<string, string[]> = {
  attendance: ["course_id"],
  marks: ["course_id", "semester"],
  timetable_slots: ["course_id", "instructor_id"],
  course_enrollments: ["course_id", "semester_id"],
  attendance_correction_requests: ["course_id"],
  substitution_assignments: ["course_id"],
};

const ROOTS = ["app", "lib", "components", "mobile/src"];
const SKIP = new Set(["node_modules", ".next", ".open-next", ".wrangler", "dist", "build", ".git"]);

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full)) found.push(full);
    }
  };
  for (const root of ROOTS) walk(join(process.cwd(), root));
  return found;
}

interface Hit {
  file: string;
  line: number;
  table: string;
  column: string;
  text: string;
}

/**
 * Two windows, because the two signals differ in how certain they are.
 *
 * A filter argument — .eq("course_id", …) — names a column of the table in
 * the `.from()` it is chained to. That is unambiguous, so it gets a long
 * window covering the whole query chain.
 *
 * A property read — `o.instructor_id` — names a column of whatever query
 * produced that variable, which is NOT necessarily the nearest `.from()`.
 * Inside a Promise.all of several queries the nearest one is routinely the
 * wrong one: director/faculty reads `o.instructor_id` off a course_offerings
 * result while a timetable_slots query sits between the two lines. Resolving
 * that properly needs dataflow analysis; instead the property signal only
 * fires close to its `.from()` and only when no other `.from()` intervenes,
 * which is exactly the shape the real defects took.
 */
const FILTER_WINDOW = 25;
const PROPERTY_WINDOW = 12;

function scan(): Hit[] {
  const hits: Hit[] = [];
  const fromRe = /\.from\(\s*["'](\w+)["']/;

  for (const file of sourceFiles()) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let table: string | null = null;
    let tableLine = -1;
    let intervening = false; // another .from() seen since `table` was set

    lines.forEach((line, i) => {
      const m = fromRe.exec(line);
      if (m) {
        if (table && m[1] !== table) intervening = true;
        table = m[1];
        tableLine = i;
        intervening = false;
      }
      if (!table || !(table in DROPPED_BY_047)) return;
      const distance = i - tableLine;
      if (distance > FILTER_WINDOW) return;

      const text = line.trim();
      if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;

      for (const column of DROPPED_BY_047[table]) {
        const asFilter = new RegExp(`\\.(eq|in|neq|is|order|gt|lt|gte|lte)\\(\\s*["']${column}["']`);
        const asProperty = new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${column}\\b`);
        // A bare column in a select list, not followed by "(" — which would
        // make it an embed alias naming another table's key.
        const inSelect = new RegExp(`["'][^"']*(^|[,\\s(])${column}\\s*(,|["'])`);

        const propertyApplies =
          !intervening && distance <= PROPERTY_WINDOW && asProperty.test(line);

        if (asFilter.test(line) || inSelect.test(line) || propertyApplies) {
          hits.push({ file: file.replace(process.cwd(), "").replace(/\\/g, "/"), line: i + 1, table, column, text: text.slice(0, 120) });
          break;
        }
      }
    });
  }
  return hits;
}

describe("no application code reads a column migration 047 drops", () => {
  it("finds zero stale references", () => {
    const hits = scan();
    const report = hits.map((h) => `${h.file}:${h.line}  ${h.table}.${h.column}  ${h.text}`);
    expect(report, `stale reads of columns 047 drops:\n${report.join("\n")}`).toEqual([]);
  });

  it("the scanner actually detects a stale reference when one exists", () => {
    // Guards the guard. A scanner whose regexes stop matching would report a
    // clean repository forever, which is the same failure it was written to
    // prevent — so the detection itself is asserted against known-bad text.
    const bad = [
      `.from("attendance").select("*, courses(name)").eq("course_id", x)`,
      `.from("marks").order("semester", { ascending: false })`,
      `const key = r.course_id;`,
    ];
    const fromRe = /\.from\(\s*["'](\w+)["']/;
    let table: string | null = null;
    let detected = 0;
    for (const line of bad) {
      const m = fromRe.exec(line);
      if (m) table = m[1];
      const t = table ?? "attendance";
      for (const column of DROPPED_BY_047[t] ?? []) {
        const asFilter = new RegExp(`\\.(eq|in|neq|is|order|gt|lt|gte|lte)\\(\\s*["']${column}["']`);
        const asProperty = new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${column}\\b`);
        if (asFilter.test(line) || asProperty.test(line)) {
          detected++;
          break;
        }
      }
    }
    expect(detected).toBe(bad.length);
  });
});
