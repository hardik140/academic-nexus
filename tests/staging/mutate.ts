import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MIGRATION = join(ROOT, "supabase/migrations/047_academic_transactions_on_offerings.sql");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * Builds a database from the REAL chain with one control in 047 weakened.
 *
 * A mutation test asserts that the attack the control exists to stop now
 * SUCCEEDS — which is the only way to know the control is load-bearing
 * rather than decorative. A mutation whose pattern no longer matches throws:
 * silently running the correct SQL would make the test assert that a defect
 * is absent from a migration the defect was never introduced into.
 */
export async function mutated(label: string, mutate: (sql: string) => string): Promise<PGlite> {
  const original = lf(readFileSync(MIGRATION, "utf8"));
  const changed = mutate(original);
  if (changed === original) {
    throw new Error(`Mutation "${label}" did not change the migration — its pattern no longer matches.`);
  }
  const db = new PGlite();
  await db.exec(lf(readFileSync(join(ROOT, "tests/staging/platform.sql"), "utf8")));
  for (const f of readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(f.startsWith("047_") ? changed : lf(readFileSync(join(ROOT, "supabase/migrations", f), "utf8")));
  }
  await db.exec(lf(readFileSync(join(ROOT, "tests/staging/qa-dataset.sql"), "utf8")));
  return db;
}
