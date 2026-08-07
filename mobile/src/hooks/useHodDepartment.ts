import { useEffect, useState, useCallback } from "react";
import type { Tables } from "@shared/types/database";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";

/**
 * Resolved via departments.hod_id, NOT profiles.department_id — assigning
 * someone as HOD doesn't set their own profile's department_id, so that
 * field is the wrong join key here (same gotcha the web HOD pages document).
 */
export function useHodDepartment() {
  const { session } = useAuth();
  const [department, setDepartment] = useState<Tables<"departments"> | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!session?.user.id) {
      setDepartment(null);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("departments")
      .select("*")
      .eq("hod_id", session.user.id)
      .single();
    setDepartment(data);
    setLoading(false);
  }, [session?.user.id]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  return { department, loading, reload };
}
