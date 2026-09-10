import type { PGlite } from "@electric-sql/pglite";

/**
 * A minimal PostgREST-shaped client backed by PGlite, so a real Server
 * Action can be executed against a real PostgreSQL with real RLS.
 *
 * WHY THIS EXISTS
 *
 * The C3 defect is "the application reports success while the database
 * changed nothing". Proving that is fixed needs both halves in one test:
 * the actual action code (its authorization, its row building, its return
 * value) AND an actual database that can refuse the write. A mocked client
 * can only assert what I already decided it should return; it cannot
 * discover that RLS silently matched zero rows, because I would be the one
 * writing the zero.
 *
 * WHAT IT IS NOT
 *
 * Not a PostgREST implementation. It supports exactly the query shapes the
 * academic mutation paths use, listed in the switch statements below, and
 * throws on anything else rather than quietly returning something plausible
 * — a shim that guesses is worse than no shim, because it produces
 * confident wrong answers.
 *
 * It is also not authoritative about RLS semantics. tests/rls-offering-
 * authority.test.ts establishes those against raw SQL; the tests built on
 * this shim assert the SAME allow/deny outcomes, so a shim that were more
 * permissive than PostgREST would show up as a disagreement between the two
 * suites rather than as silence.
 *
 * Errors are RETURNED, not thrown — `{ data: null, error: { message } }` —
 * because that is what supabase-js does, and the entire C3 question is what
 * the application does with the difference between an error and an empty
 * result.
 */

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "in"; column: string; value: unknown };
type Result<T = Row[]> = { data: T | null; error: { message: string } | null };

interface Embed {
  alias: string;
  fk: string;
  columns: string[];
}

/** Splits `"id, name, courses:course_id(department_id)"` into both halves. */
function parseSelect(select: string): { columns: string[]; embeds: Embed[] } {
  const embeds: Embed[] = [];
  const withoutEmbeds = select.replace(/(\w+):(\w+)\(([^)]*)\)/g, (_m, alias, fk, cols) => {
    embeds.push({
      alias,
      fk,
      columns: cols.split(",").map((c: string) => c.trim()).filter(Boolean),
    });
    return "";
  });

  const columns = withoutEmbeds
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  return { columns, embeds };
}

/** The table an embed's foreign key points at, for the tables in play here. */
const EMBED_TARGET: Record<string, string> = {
  course_id: "courses",
  section_id: "sections",
  student_id: "students",
  offering_id: "course_offerings",
  semester_id: "semesters",
};

export function createShimClient(db: PGlite, userId: string | null) {
  /**
   * Every statement runs as `authenticated` with auth.uid() bound, which is
   * what makes RLS apply at all — a superuser bypasses policies entirely and
   * would make every test pass for the wrong reason.
   */
  async function run(sql: string, params: unknown[]): Promise<Result> {
    await db.exec(
      `SET ROLE authenticated; SET test.user_id = ${userId ? `'${userId}'` : "''"};`
    );
    try {
      const res = await db.query<Row>(sql, params);
      return { data: res.rows ?? [], error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    } finally {
      await db.exec("RESET ROLE; RESET test.user_id;");
    }
  }

  async function resolveEmbeds(rows: Row[], embeds: Embed[]): Promise<Row[]> {
    if (embeds.length === 0) return rows;
    const out: Row[] = [];
    for (const row of rows) {
      const copy: Row = { ...row };
      for (const embed of embeds) {
        const target = EMBED_TARGET[embed.fk];
        if (!target) throw new Error(`shim: no embed target known for '${embed.fk}'`);
        const fkValue = row[embed.fk];
        if (fkValue == null) {
          copy[embed.alias] = null;
          continue;
        }
        const nested = await run(
          `SELECT ${embed.columns.join(", ")} FROM public.${target} WHERE id = $1`,
          [fkValue]
        );
        copy[embed.alias] = nested.data?.[0] ?? null;
      }
      out.push(copy);
    }
    return out;
  }

  function where(filters: Filter[], startIndex: number) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let i = startIndex;
    for (const f of filters) {
      if (f.op === "eq") {
        clauses.push(`${f.column} = $${i++}`);
        params.push(f.value);
      } else {
        clauses.push(`${f.column} = ANY($${i++})`);
        params.push(f.value);
      }
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  function from(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "upsert" | "update" = "select";
    let selectSpec = "*";
    let payload: Row[] = [];
    let patch: Row = {};
    let conflictTarget = "";
    let hasReturning = false;

    async function execute(): Promise<Result> {
      const { columns, embeds } = parseSelect(selectSpec);
      // Embedded joins need their foreign key in the projection even when the
      // caller did not ask for it by name.
      const projection =
        columns.includes("*") || columns.length === 0
          ? "*"
          : Array.from(new Set([...columns, ...embeds.map((e) => e.fk)])).join(", ");

      let result: Result;

      switch (mode) {
        case "select": {
          const w = where(filters, 1);
          result = await run(`SELECT ${projection} FROM public.${table}${w.sql}`, w.params);
          break;
        }
        case "insert":
        case "upsert": {
          if (payload.length === 0) return { data: [], error: null };
          const cols = Object.keys(payload[0]);
          const params: unknown[] = [];
          const tuples = payload.map((row) => {
            const placeholders = cols.map((c) => {
              params.push(row[c]);
              return `$${params.length}`;
            });
            return `(${placeholders.join(", ")})`;
          });
          let sql = `INSERT INTO public.${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`;
          if (mode === "upsert") {
            if (!conflictTarget) throw new Error("shim: upsert requires onConflict");
            const assignments = cols
              .filter((c) => !conflictTarget.split(",").map((s) => s.trim()).includes(c))
              .map((c) => `${c} = EXCLUDED.${c}`);
            sql += ` ON CONFLICT (${conflictTarget}) DO UPDATE SET ${assignments.join(", ")}`;
          }
          if (hasReturning) sql += ` RETURNING ${projection}`;
          result = await run(sql, params);
          break;
        }
        case "update": {
          const params: unknown[] = [];
          const sets = Object.keys(patch).map((c) => {
            params.push(patch[c]);
            return `${c} = $${params.length}`;
          });
          const w = where(filters, params.length + 1);
          let sql = `UPDATE public.${table} SET ${sets.join(", ")}${w.sql}`;
          if (hasReturning) sql += ` RETURNING ${projection}`;
          result = await run(sql, [...params, ...w.params]);
          break;
        }
      }

      if (result.error || !result.data) return result;
      return { data: await resolveEmbeds(result.data, embeds), error: null };
    }

    const builder: Record<string, unknown> = {
      select(spec?: string) {
        selectSpec = spec ?? "*";
        hasReturning = true;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ op: "eq", column, value });
        return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push({ op: "in", column, value });
        return builder;
      },
      insert(rows: Row | Row[]) {
        mode = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        hasReturning = false;
        return builder;
      },
      upsert(rows: Row | Row[], options?: { onConflict?: string }) {
        mode = "upsert";
        payload = Array.isArray(rows) ? rows : [rows];
        conflictTarget = options?.onConflict ?? "";
        hasReturning = false;
        return builder;
      },
      update(values: Row) {
        mode = "update";
        patch = values;
        hasReturning = false;
        return builder;
      },
      async maybeSingle() {
        const res = await execute();
        if (res.error) return { data: null, error: res.error };
        const rows = res.data ?? [];
        if (rows.length > 1) {
          return { data: null, error: { message: "multiple rows returned" } };
        }
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const res = await execute();
        if (res.error) return { data: null, error: res.error };
        const rows = res.data ?? [];
        if (rows.length !== 1) {
          return { data: null, error: { message: "expected exactly one row" } };
        }
        return { data: rows[0], error: null };
      },
      then(resolve: (v: Result) => unknown, reject?: (e: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };

    return builder;
  }

  return { from } as never;
}
