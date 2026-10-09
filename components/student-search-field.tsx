"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { FormField } from "@/components/ui/modal";

/**
 * Pick a student by searching, instead of from a list of every student.
 *
 * The invoice, scholarship and placement-record forms used to load every
 * student into a dropdown. PostgREST returns at most 1,000 rows to that
 * select, so in a larger college students past the first 1,000 (by
 * enrollment number) could not be chosen at all. This asks the database for
 * at most 25 matches of what was typed (migration 059, search_students),
 * under the user's RLS — the same students the old list could show, minus
 * the cap.
 */

interface StudentMatch {
  id: string;
  enrollment_number: string | null;
  full_name: string | null;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;
const MAX_RESULTS = 25;

export function StudentSearchField({
  id,
  label = "Student",
  value,
  onChange,
  required,
}: {
  id: string;
  label?: string;
  value: string;
  onChange: (studentId: string) => void;
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<StudentMatch[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const supabase = createClient() as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: StudentMatch[] | null; error: { message: string } | null }>;
      };
      // Called as a method: SupabaseClient.rpc uses `this`.
      const { data, error: searchError } = await supabase.rpc("search_students", { p_query: q, p_limit: MAX_RESULTS });
      if (cancelled) return;
      if (searchError) {
        setError("Could not search students. Try again.");
        setMatches([]);
        return;
      }
      setError(undefined);
      setMatches(data ?? []);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const options = matches.map((s) => ({
    value: s.id,
    label: `${s.enrollment_number ?? "—"} — ${s.full_name ?? "Unknown"}`,
  }));

  return (
    <div className="space-y-sm">
      <FormField
        label={`Search ${label.toLowerCase()} by name or enrollment number`}
        id={`${id}-search`}
        value={query}
        onChange={setQuery}
        placeholder={`Type at least ${MIN_QUERY} characters`}
        error={error}
      />
      <FormField
        label={label}
        id={id}
        type="select"
        value={value}
        onChange={onChange}
        options={options}
        required={required}
        disabled={options.length === 0}
      />
    </div>
  );
}
