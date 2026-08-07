import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, CardTitle, EmptyState, StatusBadge, colors } from "@/components/ui";
import { formatDate, formatPct } from "@/lib/format";

export default function AttendanceScreen() {
  const { student, loading: studentLoading } = useStudent();
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!student?.id) return;
    const { data } = await supabase
      .from("attendance")
      .select("*, courses(name, code)")
      .eq("student_id", student.id)
      .order("date", { ascending: false })
      .limit(500);
    setRecords(data || []);
    setLoading(false);
  };

  useEffect(() => {
    if (!studentLoading) load();
  }, [studentLoading, student?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const courseSummary: Record<string, { name: string; code: string; present: number; total: number }> = {};
  records.forEach((r: any) => {
    const key = r.course_id;
    if (!courseSummary[key]) courseSummary[key] = { name: r.courses?.name || "", code: r.courses?.code || "", present: 0, total: 0 };
    courseSummary[key].total++;
    if (r.status === "present" || r.status === "late") courseSummary[key].present++;
  });
  const summaries = Object.values(courseSummary);
  const overall = summaries.reduce((acc, s) => ({ present: acc.present + s.present, total: acc.total + s.total }), { present: 0, total: 0 });
  const overallPct = overall.total > 0 ? (overall.present / overall.total) * 100 : 0;
  const overallColor = overallPct >= 75 ? colors.success : colors.error;

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <Card>
        <Text style={styles.overallLabel}>Overall Attendance</Text>
        <Text style={[styles.overallValue, { color: overallColor }]}>{formatPct(overallPct, 0)}</Text>
        <Text style={styles.overallSub}>{overall.present} present out of {overall.total} classes</Text>
        {overallPct < 75 && overall.total > 0 && (
          <View style={styles.warningPill}>
            <Text style={styles.warningPillText}>⚠️ Below the 75% requirement</Text>
          </View>
        )}
      </Card>

      <Card>
        <CardTitle>Course-wise Attendance</CardTitle>
        {summaries.length > 0 ? (
          summaries.map((s) => {
            const pct = (s.present / s.total) * 100;
            const c = pct >= 75 ? colors.success : colors.error;
            return (
              <View key={s.code} style={styles.courseRow}>
                <View style={styles.headerRow}>
                  <Text style={styles.rowTitle}>{s.code} <Text style={styles.rowSub}>{s.name}</Text></Text>
                  <Text style={[styles.pctText, { color: c }]}>{formatPct(pct, 0)}</Text>
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: c }]} />
                </View>
                <Text style={styles.rowSub}>{s.present}/{s.total} classes</Text>
              </View>
            );
          })
        ) : (
          <EmptyState>No attendance records yet.</EmptyState>
        )}
      </Card>

      <Card>
        <CardTitle>Recent Records</CardTitle>
        {records.length > 0 ? (
          records.slice(0, 20).map((r: any) => (
            <View key={r.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{r.courses?.code} — {r.courses?.name}</Text>
                <Text style={styles.rowSub}>{formatDate(r.date)}</Text>
              </View>
              <StatusBadge status={r.status} />
            </View>
          ))
        ) : (
          <EmptyState>No records yet.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  overallLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase" },
  overallValue: { fontSize: 36, fontWeight: "800", marginTop: 4 },
  overallSub: { fontSize: 12, color: colors.outline, marginTop: 4 },
  warningPill: { marginTop: 8, backgroundColor: "#BA1A1A15", alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  warningPillText: { fontSize: 11, fontWeight: "700", color: colors.error },
  courseRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  rowTitle: { fontSize: 13, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 11, color: colors.outline },
  pctText: { fontSize: 14, fontWeight: "800" },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: "#E5E5EA", overflow: "hidden", marginBottom: 4 },
  barFill: { height: "100%", borderRadius: 3 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
});
