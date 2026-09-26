import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MIGRATION_047 = "047_academic_transactions_on_offerings.sql";
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * Builds a database from the REAL chain with one control weakened.
 *
 * A mutation test asserts that the attack the control exists to stop now
 * SUCCEEDS — which is the only way to know the control is load-bearing
 * rather than decorative. A mutation whose pattern no longer matches throws:
 * silently running the correct SQL would make the test assert that a defect
 * is absent from a migration the defect was never introduced into.
 *
 * `mutate` is applied to the named migration's text; every other file in the
 * chain is applied unchanged, so the result is the real schema minus exactly
 * one control.
 */
export async function mutatedFile(
  file: string,
  label: string,
  mutate: (sql: string) => string
): Promise<PGlite> {
  return mutatedFiles(label, { [file]: mutate });
}

/**
 * The same thing across SEVERAL migrations at once.
 *
 * Needed because a control is not always written in one place. Two cases in
 * this repo: a rule enforced by an RLS policy in one migration and a trigger
 * in another, and a function that a later migration redefines with CREATE OR
 * REPLACE — where mutating only the earlier copy changes nothing, because the
 * later definition is the one that survives the chain. That failure mode is
 * silent and dangerous (the test would assert a defect is absent from a
 * database it was never introduced into), so EVERY named file must actually
 * change or this throws.
 */
export async function mutatedFiles(
  label: string,
  mutations: Record<string, (sql: string) => string>
): Promise<PGlite> {
  const changed = new Map<string, string>();

  for (const [file, mutate] of Object.entries(mutations)) {
    const original = lf(readFileSync(join(ROOT, "supabase/migrations", file), "utf8"));
    const next = mutate(original);
    if (next === original) {
      throw new Error(`Mutation "${label}" did not change ${file} — its pattern no longer matches.`);
    }
    changed.set(file, next);
  }

  const db = new PGlite();
  await db.exec(lf(readFileSync(join(ROOT, "tests/staging/platform.sql"), "utf8")));
  for (const f of readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(changed.get(f) ?? lf(readFileSync(join(ROOT, "supabase/migrations", f), "utf8")));
  }
  await db.exec(lf(readFileSync(join(ROOT, "tests/staging/qa-dataset.sql"), "utf8")));
  return db;
}

/** The original 047-only entry point, kept so existing suites read unchanged. */
export function mutated(label: string, mutate: (sql: string) => string): Promise<PGlite> {
  return mutatedFile(MIGRATION_047, label, mutate);
}
