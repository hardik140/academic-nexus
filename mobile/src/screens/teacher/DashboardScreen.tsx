import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { Screen, Card, CardTitle, EmptyState, colors } from "@/components/ui";
import type { Tables } from "@shared/types/database";

export default function DashboardScreen() {
  const { session } = useAuth();
  const { profile } = useProfile();
  const [courses, setCourses] = useState<Tables<"courses">[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  const load = useCallback(async () => {
    if (!session?.user.id) return;
    const [coursesRes, attendanceRes] = await Promise.all([
      supabase.from("courses").select("*").eq("instructor_id", session.user.id),
      supabase.from("attendance").select("id", { count: "exact", head: true }).eq("marked_by", session.user.id).eq("date", today),
    ]);
    setCourses(coursesRes.data || []);
    setTodayCount(attendanceRes.count || 0);
    setLoading(false);
  }, [session?.user.id, today]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>Welcome, {profile?.full_name?.split(" ")[0] || "Professor"} 👋</Text>
      <Text style={styles.subtitle}>Faculty Dashboard • {today}</Text>

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>My Courses</Text>
          <Text style={styles.kpiValue}>{courses.length}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Today&apos;s Entries</Text>
          <Text style={[styles.kpiValue, { color: colors.info }]}>{todayCount}</Text>
        </Card>
      </View>

      <Card>
        <CardTitle>My Courses</CardTitle>
        {courses.length > 0 ? (
          courses.map((c) => (
            <View key={c.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{c.code} — {c.name}</Text>
                <Text style={styles.rowSub}>{c.credits} credits • Sem {c.semester}</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>No courses assigned yet.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { fontSize: 22, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textVariant, marginBottom: 4 },
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 24, fontWeight: "800", color: colors.text },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
