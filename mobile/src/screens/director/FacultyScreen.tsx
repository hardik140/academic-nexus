import { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function FacultyScreen() {
  const [faculty, setFaculty] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [facultyRes, coursesRes] = await Promise.all([
      supabase.from("profiles").select("*, departments:department_id(name, code)").in("role", ["teacher", "hod"]).order("full_name"),
      // Workload counts DELIVERIES. courses.instructor_id counted a
      // three-section teacher as teaching one course.
      supabase.from("course_offerings").select("id, instructor_id, status"),
    ]);
    const courseCounts: Record<string, number> = {};
    (coursesRes.data || []).forEach((c: any) => {
      if (!c.instructor_id || c.status === "cancelled") return;
      courseCounts[c.instructor_id] = (courseCounts[c.instructor_id] || 0) + 1;
    });
    setFaculty((facultyRes.data || []).map((f: any) => ({ ...f, course_count: courseCounts[f.id] || 0 })));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = faculty.filter(
    (f: any) =>
      !search ||
      f.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      f.departments?.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, department, or role..."
        placeholderTextColor="#9AA0A6"
      />

      {filtered.map((f: any) => (
        <Card key={f.id}>
          <View style={styles.headerRow}>
            <Text style={styles.name}>{f.full_name}</Text>
            <View style={[styles.statusPill, { backgroundColor: f.status === "active" ? "#1B8A3E15" : "#BA1A1A15" }]}>
              <Text style={[styles.statusPillText, { color: f.status === "active" ? colors.success : colors.error }]}>{f.status}</Text>
            </View>
          </View>
          <Text style={styles.meta}>{f.departments?.name || "—"} • {f.role}</Text>
          <Text style={styles.courseCount}>{f.course_count} course{f.course_count === 1 ? "" : "s"}</Text>
        </Card>
      ))}
      {filtered.length === 0 && (
        <Card>
          <EmptyState>{faculty.length === 0 ? "No faculty records found." : "No faculty match your search."}</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  name: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  meta: { fontSize: 12, color: colors.outline, textTransform: "capitalize" },
  courseCount: { fontSize: 12, color: colors.textVariant, fontWeight: "600", marginTop: 6 },
});
