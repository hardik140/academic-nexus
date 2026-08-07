import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useProfile } from "@/hooks/useProfile";
import { useHodDepartment } from "@/hooks/useHodDepartment";
import { Screen, Card, CardTitle, EmptyState, colors } from "@/components/ui";
import type { Tables } from "@shared/types/database";

export default function DashboardScreen() {
  const { profile } = useProfile();
  const { department, loading: deptLoading, reload: reloadDept } = useHodDepartment();
  const [faculty, setFaculty] = useState<Tables<"profiles">[]>([]);
  const [courseCount, setCourseCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!department?.id) {
      setLoading(false);
      return;
    }
    const [facultyRes, coursesRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("role", "teacher").eq("department_id", department.id),
      supabase.from("courses").select("id", { count: "exact", head: true }).eq("department_id", department.id),
    ]);
    setFaculty(facultyRes.data || []);
    setCourseCount(coursesRes.count || 0);
    setLoading(false);
  }, [department?.id]);

  useEffect(() => {
    if (!deptLoading) load();
  }, [deptLoading, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([reloadDept(), load()]);
    setRefreshing(false);
  };

  return (
    <Screen loading={loading || deptLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>{department?.name || "Department"} — HOD Dashboard</Text>
      <Text style={styles.subtitle}>Head of Department • {profile?.full_name}</Text>

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Faculty</Text>
          <Text style={styles.kpiValue}>{faculty.length}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Courses</Text>
          <Text style={[styles.kpiValue, { color: colors.info }]}>{courseCount}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Dept Code</Text>
          <Text style={styles.kpiValue}>{department?.code || "—"}</Text>
        </Card>
      </View>

      <Card>
        <CardTitle>Faculty Members</CardTitle>
        {faculty.length > 0 ? (
          faculty.map((f) => (
            <View key={f.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{f.full_name}</Text>
                <Text style={styles.rowSub}>{f.email}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: f.status === "active" ? "#1B8A3E20" : "#BA1A1A20" }]}>
                <Text style={[styles.statusPillText, { color: f.status === "active" ? colors.success : colors.error }]}>
                  {f.status}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>No faculty members assigned to this department.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textVariant, marginBottom: 4 },
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1, alignItems: "center" },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 20, fontWeight: "800", color: colors.text },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
});
