import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, CardTitle, EmptyState, StatusBadge, colors } from "@/components/ui";
import { formatCurrency, formatDate, formatPct } from "@/lib/format";

export default function DashboardScreen() {
  const { session } = useAuth();
  const { profile } = useProfile();
  const { student, loading: studentLoading, reload: reloadStudent } = useStudent();
  const [attendance, setAttendance] = useState<any[]>([]);
  const [fees, setFees] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session?.user.id) return;
    const [attendanceRes, feesRes, notifRes] = await Promise.all([
      supabase.from("attendance").select("*, course_offerings:offering_id(courses:course_id(name, code), sections:section_id(name))").eq("student_id", student?.id || "").order("date", { ascending: false }).limit(10),
      supabase.from("fees").select("*").eq("student_id", student?.id || "").in("status", ["pending", "overdue"]).order("due_date", { ascending: true }),
      supabase.from("notifications").select("*").eq("receiver_id", session.user.id).eq("read", false).order("created_at", { ascending: false }).limit(5),
    ]);
    setAttendance(attendanceRes.data || []);
    setFees(feesRes.data || []);
    setNotifications(notifRes.data || []);
    setLoading(false);
  }, [session?.user.id, student?.id]);

  useEffect(() => {
    if (!studentLoading) load();
  }, [studentLoading, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([reloadStudent(), load()]);
    setRefreshing(false);
  };

  const totalClasses = attendance.length || 1;
  const presentCount = attendance.filter((a) => a.status === "present" || a.status === "late").length;
  const attendancePct = (presentCount / totalClasses) * 100;
  const totalFeesDue = fees.reduce((s, f) => s + (f.amount - f.paid_amount), 0);
  const cgpa = student?.cgpa || 0;

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>Welcome back, {profile?.full_name?.split(" ")[0] || "Student"} 👋</Text>
      <Text style={styles.subtitle}>
        Semester {student?.semester || 1} • Batch {student?.batch_year || new Date().getFullYear()}
      </Text>

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>CGPA</Text>
          <Text style={styles.kpiValue}>{cgpa.toFixed(2)}</Text>
          <Text style={styles.kpiSub}>out of 10.00</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Attendance</Text>
          <Text style={[styles.kpiValue, { color: attendancePct >= 75 ? colors.success : colors.error }]}>
            {formatPct(attendancePct, 0)}
          </Text>
          <Text style={styles.kpiSub}>{presentCount}/{totalClasses} classes</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Credits</Text>
          <Text style={styles.kpiValue}>{student?.credits_completed || 0}</Text>
          <Text style={styles.kpiSub}>of {student?.credits_required || 160} required</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Fees Due</Text>
          <Text style={[styles.kpiValue, { color: totalFeesDue > 0 ? colors.warning : colors.success }]}>
            {totalFeesDue > 0 ? formatCurrency(totalFeesDue) : "Clear"}
          </Text>
          <Text style={styles.kpiSub}>{fees.length} pending invoice{fees.length !== 1 ? "s" : ""}</Text>
        </Card>
      </View>

      <Card>
        <CardTitle>Recent Attendance</CardTitle>
        {attendance.length > 0 ? (
          attendance.slice(0, 6).map((r: any) => (
            <View key={r.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{r.course_offerings?.courses?.name || "Class"}</Text>
                <Text style={styles.rowSub}>
                  {r.course_offerings?.courses?.code}
                  {r.course_offerings?.sections?.name ? ` · ${r.course_offerings.sections.name}` : ""}
                  {` • ${formatDate(r.date)}`}
                </Text>
              </View>
              <StatusBadge status={r.status} />
            </View>
          ))
        ) : (
          <EmptyState>No attendance records yet.</EmptyState>
        )}
      </Card>

      <Card>
        <CardTitle>Notifications</CardTitle>
        {notifications.length > 0 ? (
          notifications.map((n: any) => (
            <View key={n.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{n.title}</Text>
                <Text style={styles.rowSub} numberOfLines={2}>{n.message}</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>All caught up! No new notifications.</EmptyState>
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
  kpiSub: { fontSize: 11, color: colors.outline, marginTop: 4 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
