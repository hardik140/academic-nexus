import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, CardTitle, EmptyState, colors } from "@/components/ui";

export default function DashboardScreen() {
  const [stats, setStats] = useState({
    totalStudents: 0,
    totalTeachers: 0,
    totalCourses: 0,
    totalDepartments: 0,
    pendingComplaints: 0,
    pendingGatePasses: 0,
  });
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [students, teachers, courses, departments, complaints, gatePasses, logsRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student"),
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "teacher"),
      supabase.from("courses").select("id", { count: "exact", head: true }),
      supabase.from("departments").select("id", { count: "exact", head: true }),
      supabase.from("complaints").select("id", { count: "exact", head: true }).eq("status", "open"),
      supabase.from("gate_passes").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("audit_logs").select("*, profiles:user_id(full_name)").order("created_at", { ascending: false }).limit(8),
    ]);
    setStats({
      totalStudents: students.count || 0,
      totalTeachers: teachers.count || 0,
      totalCourses: courses.count || 0,
      totalDepartments: departments.count || 0,
      pendingComplaints: complaints.count || 0,
      pendingGatePasses: gatePasses.count || 0,
    });
    setRecentLogs(logsRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const tiles = [
    { label: "Students", value: stats.totalStudents, color: colors.primary },
    { label: "Faculty", value: stats.totalTeachers, color: colors.success },
    { label: "Courses", value: stats.totalCourses, color: colors.info },
    { label: "Departments", value: stats.totalDepartments, color: colors.warning },
    { label: "Open Complaints", value: stats.pendingComplaints, color: colors.error },
    { label: "Pending Passes", value: stats.pendingGatePasses, color: colors.textVariant },
  ];

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>System Administration</Text>
      <Text style={styles.subtitle}>Manage users, roles, departments, and configuration</Text>

      <View style={styles.grid}>
        {tiles.map((t) => (
          <Card key={t.label} style={styles.tile}>
            <Text style={styles.tileLabel}>{t.label}</Text>
            <Text style={[styles.tileValue, { color: t.color }]}>{t.value}</Text>
          </Card>
        ))}
      </View>

      <Card>
        <CardTitle>Recent Audit Log</CardTitle>
        {recentLogs.length > 0 ? (
          recentLogs.map((log: any) => (
            <View key={log.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{log.action}</Text>
                <Text style={styles.rowSub}>{log.profiles?.full_name || "System"} • {log.table_name}</Text>
              </View>
              <Text style={styles.timestamp}>{new Date(log.created_at).toLocaleDateString()}</Text>
            </View>
          ))
        ) : (
          <EmptyState>No audit log entries yet.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textVariant, marginBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: { width: "47%" },
  tileLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  tileValue: { fontSize: 22, fontWeight: "800" },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 13, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  timestamp: { fontSize: 11, color: colors.outline },
});
