import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function AnalyticsScreen() {
  const [attendance, setAttendance] = useState<any[]>([]);
  const [fees, setFees] = useState<any>(null);
  const [enrollment, setEnrollment] = useState<any[]>([]);
  const [placement, setPlacement] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [attRes, feeRes, enrollRes, placeRes] = await Promise.all([
      supabase.from("mv_attendance_summary").select("*"),
      supabase.from("mv_fee_summary").select("*").maybeSingle(),
      supabase.from("mv_department_enrollment").select("*").order("total_students", { ascending: false }),
      supabase.from("mv_placement_summary").select("*").maybeSingle(),
    ]);
    setAttendance(attRes.data || []);
    setFees(feeRes.data);
    setEnrollment(enrollRes.data || []);
    setPlacement(placeRes.data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const totalEnrolled = enrollment.reduce((s, d) => s + (d.total_students || 0), 0);
  const maxStudents = Math.max(...enrollment.map((d: any) => d.total_students || 1), 1);

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Enrolled</Text>
          <Text style={styles.kpiValue}>{totalEnrolled}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Collection</Text>
          <Text style={[styles.kpiValue, { color: (fees?.collection_pct || 0) >= 80 ? colors.success : colors.warning }]}>
            {fees?.collection_pct || 0}%
          </Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Placed</Text>
          <Text style={[styles.kpiValue, { color: colors.primary }]}>{placement?.total_placed || 0}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Avg Package</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>₹{placement?.avg_package || 0}L</Text>
        </Card>
      </View>

      <Card>
        <Text style={styles.title}>Department-wise Enrollment</Text>
        {enrollment.length > 0 ? (
          enrollment.map((dept: any) => (
            <View key={dept.department_id} style={styles.deptRow}>
              <View style={styles.deptHeader}>
                <Text style={styles.deptName}>{dept.department_code} <Text style={styles.deptFullName}>{dept.department_name}</Text></Text>
                <Text style={styles.deptMeta}>{dept.active_students} active</Text>
              </View>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${(dept.total_students / maxStudents) * 100}%` }]} />
              </View>
            </View>
          ))
        ) : (
          <EmptyState>Analytics views are empty. Refresh the materialized views after adding data.</EmptyState>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>Attendance Rates by Course</Text>
        {attendance.length > 0 ? (
          attendance.map((a: any) => (
            <View key={a.offering_id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{a.course_code}</Text>
                <Text style={styles.rowSub}>{a.course_name}</Text>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 18, fontWeight: "800", color: colors.text },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  deptRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  deptHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  deptName: { fontSize: 13, fontWeight: "700", color: colors.text },
  deptFullName: { fontSize: 11, fontWeight: "400", color: colors.outline },
  deptMeta: { fontSize: 12, color: colors.textVariant },
  barTrack: { height: 6, backgroundColor: colors.surfaceLow, borderRadius: 999, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: colors.primary, borderRadius: 999 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  pct: { fontSize: 15, fontWeight: "800" },
});
