import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function DepartmentsScreen() {
  const [departments, setDepartments] = useState<any[]>([]);
  const [enrollmentByDept, setEnrollmentByDept] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [deptRes, enrollRes] = await Promise.all([
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
      supabase.from("mv_department_enrollment").select("*"),
    ]);
    setDepartments(deptRes.data || []);
    const byDept: Record<string, any> = {};
    (enrollRes.data || []).forEach((e: any) => { byDept[e.department_id] = e; });
    setEnrollmentByDept(byDept);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {departments.map((d: any) => {
        const e = enrollmentByDept[d.id];
        return (
          <Card key={d.id}>
            <View style={styles.headerRow}>
              <Text style={styles.code}>{d.code}</Text>
              <View style={[styles.statusPill, { backgroundColor: d.status === "active" ? "#1B8A3E15" : "#BA1A1A15" }]}>
                <Text style={[styles.statusPillText, { color: d.status === "active" ? colors.success : colors.error }]}>{d.status}</Text>
              </View>
            </View>
            <Text style={styles.name}>{d.name}</Text>
            <Text style={styles.meta}>HOD: {d.profiles?.full_name || "Unassigned"}</Text>
            <View style={styles.statsRow}>
              <View>
                <Text style={styles.statLabel}>Students</Text>
                <Text style={styles.statValue}>{e?.total_students || 0}</Text>
              </View>
              <View>
                <Text style={styles.statLabel}>Avg CGPA</Text>
                <Text style={styles.statValue}>{e?.avg_cgpa || "—"}</Text>
              </View>
            </View>
          </Card>
        );
      })}
      {departments.length === 0 && (
        <Card>
          <EmptyState>No departments found.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  code: { fontSize: 13, fontWeight: "800", color: colors.primary },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  meta: { fontSize: 12, color: colors.outline, marginBottom: 10 },
  statsRow: { flexDirection: "row", gap: 24 },
  statLabel: { fontSize: 10, fontWeight: "700", color: colors.outline, textTransform: "uppercase" },
  statValue: { fontSize: 14, fontWeight: "800", color: colors.text, marginTop: 2 },
});
