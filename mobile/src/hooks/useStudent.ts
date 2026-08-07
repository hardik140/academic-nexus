import { useEffect, useState, useCallback } from "react";
import type { Tables } from "@shared/types/database";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";

export function useStudent() {
  const { session } = useAuth();
  const [student, setStudent] = useState<Tables<"students"> | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!session?.user.id) {
      setStudent(null);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("students")
      .select("*")
      .eq("user_id", session.user.id)
      .single();
    setStudent(data);
    setLoading(false);
  }, [session?.user.id]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  return { student, loading, reload };
}
