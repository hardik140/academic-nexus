import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useHodDepartment } from "@/hooks/useHodDepartment";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function ReportsScreen() {
  const { department, loading: deptLoading } = useHodDepartment();
  const [enrollment, setEnrollment] = useState<any>(null);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [backlogs, setBacklogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!department?.id) {
      setLoading(false);
      return;
    }
    const [enrollRes, attendanceRes, coursesRes] = await Promise.all([
      supabase.from("mv_department_enrollment").select("*").eq("department_id", department.id).maybeSingle(),
      supabase.from("mv_attendance_summary").select("*").eq("department_id", department.id),
      supabase.from("courses").select("id").eq("department_id", department.id),
    ]);
    setEnrollment(enrollRes.data);
    setAttendance(attendanceRes.data || []);

    const courseIds = (coursesRes.data || []).map((c) => c.id);
    if (courseIds.length > 0) {
      const { data: backlogRows } = await supabase
        .from("course_enrollments")
        .select("*, courses(name, code), profiles:student_id(full_name)")
        .in("course_id", courseIds)
        .eq("status", "failed");
      setBacklogs(backlogRows || []);
    } else {
      setBacklogs([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!deptLoading) load();
  }, [deptLoading, department?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading || deptLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiValue}>{enrollment?.total_students || 0}</Text>
          <Text style={styles.kpiLabel}>Total Students</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={[styles.kpiValue, { color: colors.success }]}>{enrollment?.active_students || 0}</Text>
          <Text style={styles.kpiLabel}>Active</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={[styles.kpiValue, { color: colors.primary }]}>{enrollment?.avg_cgpa || "—"}</Text>
          <Text style={styles.kpiLabel}>Avg CGPA</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={[styles.kpiValue, { color: colors.error }]}>{backlogs.length}</Text>
          <Text style={styles.kpiLabel}>Backlogs</Text>
        </Card>
      </View>

      <Card>
        <Text style={styles.title}>📊 Attendance Audit — By Course</Text>
        {attendance.length > 0 ? (
          attendance.map((a: any) => (
            <View key={a.course_id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{a.course_code}</Text>
                <Text style={styles.rowSub}>{a.course_name}</Text>
                <Text style={styles.rowSub}>✅ {a.present_count} • ❌ {a.absent_count}</Text>
              </View>
              <Text style={[styles.pct, { color: (a.attendance_pct || 0) >= 75 ? colors.success : colors.error }]}>
                {a.attendance_pct || 0}%
              </Text>
            </View>
          ))
        ) : (
          <EmptyState>No attendance data yet.</EmptyState>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>📉 Backlog Students</Text>
        {backlogs.length > 0 ? (
          backlogs.map((b: any) => (
            <View key={b.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{b.profiles?.full_name}</Text>
                <Text style={styles.rowSub}>{b.courses?.code} — {b.courses?.name}</Text>
              </View>
              <View style={styles.failedPill}>
                <Text style={styles.failedPillText}>Failed</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>🎉 No backlogs in this department.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1, alignItems: "center" },
  kpiLabel: { fontSize: 10, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginTop: 4 },
  kpiValue: { fontSize: 20, fontWeight: "800", color: colors.text },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  pct: { fontSize: 15, fontWeight: "800" },
  failedPill: { backgroundColor: "#BA1A1A15", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  failedPillText: { fontSize: 11, fontWeight: "700", color: colors.error },
});
