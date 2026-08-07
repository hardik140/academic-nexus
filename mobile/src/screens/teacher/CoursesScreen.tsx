import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function CoursesScreen() {
  const { session } = useAuth();
  const [courses, setCourses] = useState<any[]>([]);
  const [enrollCounts, setEnrollCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!session?.user.id) return;
    const { data: courseRows } = await supabase
      .from("courses")
      .select("*, departments:department_id(name, code)")
      .eq("instructor_id", session.user.id)
      .order("code");
    setCourses(courseRows || []);

    const courseIds = (courseRows || []).map((c: any) => c.id);
    if (courseIds.length > 0) {
      const { data: enrollments } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .in("course_id", courseIds)
        .eq("status", "enrolled");
      const counts: Record<string, number> = {};
      (enrollments || []).forEach((e: any) => {
        counts[e.course_id] = (counts[e.course_id] || 0) + 1;
      });
      setEnrollCounts(counts);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {courses.map((c: any) => (
        <Card key={c.id}>
          <View style={styles.headerRow}>
            <Text style={styles.code}>{c.code}</Text>
            <View style={[styles.statusPill, c.status === "active" ? styles.statusActive : styles.statusOther]}>
              <Text style={[styles.statusPillText, { color: c.status === "active" ? colors.success : colors.warning }]}>{c.status}</Text>
            </View>
          </View>
          <Text style={styles.name}>{c.name}</Text>
          <Text style={styles.meta}>🏢 {c.departments?.name || "—"}</Text>
          <Text style={styles.meta}>📚 {c.credits} credits • Semester {c.semester} • {c.type}</Text>
          <Text style={styles.enrolled}>👥 {enrollCounts[c.id] || 0} enrolled</Text>
        </Card>
      ))}
      {courses.length === 0 && (
        <Card>
          <EmptyState>No courses assigned. Contact admin for course assignments.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  code: { fontSize: 12, fontWeight: "800", color: colors.primary, textTransform: "uppercase" },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusActive: { backgroundColor: "#1B8A3E15" },
  statusOther: { backgroundColor: "#B9860015" },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 6 },
  meta: { fontSize: 12, color: colors.outline, marginTop: 2 },
  enrolled: { fontSize: 12, color: colors.textVariant, fontWeight: "600", marginTop: 8 },
});
