import { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useHodDepartment } from "@/hooks/useHodDepartment";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function CoursesScreen() {
  const { department, loading: deptLoading } = useHodDepartment();
  const [courses, setCourses] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!department?.id) {
      setCourses([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("courses")
      .select("*, profiles:instructor_id(full_name)")
      .eq("department_id", department.id)
      .order("code");
    setCourses(data || []);
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

  const filtered = courses.filter(
    (c: any) =>
      !search ||
      c.code?.toLowerCase().includes(search.toLowerCase()) ||
      c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.profiles?.full_name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Screen loading={loading || deptLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by code, name, or instructor..."
        placeholderTextColor="#9AA0A6"
      />

      {filtered.map((c: any) => (
        <Card key={c.id}>
          <View style={styles.headerRow}>
            <Text style={styles.code}>{c.code}</Text>
            <View style={[styles.statusPill, { backgroundColor: c.status === "active" ? "#1B8A3E15" : "#B9860015" }]}>
              <Text style={[styles.statusPillText, { color: c.status === "active" ? colors.success : colors.warning }]}>{c.status}</Text>
            </View>
          </View>
          <Text style={styles.name}>{c.name}</Text>
          <Text style={styles.meta}>👤 {c.profiles?.full_name || "TBA"}</Text>
          <Text style={styles.meta}>📚 {c.credits} credits • Sem {c.semester} • {c.type}</Text>
        </Card>
      ))}
      {filtered.length === 0 && (
        <Card>
          <EmptyState>{courses.length === 0 ? "No courses found." : "No courses match your search."}</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  code: { fontSize: 12, fontWeight: "800", color: colors.primary, textTransform: "uppercase" },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 6 },
  meta: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
