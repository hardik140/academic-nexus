import { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useProfile } from "@/hooks/useProfile";
import { useHodDepartment } from "@/hooks/useHodDepartment";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function FacultyScreen() {
  const { profile } = useProfile();
  const { department, loading: deptLoading } = useHodDepartment();
  const [faculty, setFaculty] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!department?.id || !profile?.college_id) {
      setFaculty([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("profiles")
      .select("*, departments:department_id(name)")
      .eq("college_id", profile.college_id)
      .eq("department_id", department.id)
      .in("role", ["teacher", "hod"])
      .order("full_name");
    setFaculty(data || []);
    setLoading(false);
  };

  useEffect(() => {
    if (!deptLoading) load();
  }, [deptLoading, department?.id, profile?.college_id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = faculty.filter(
    (f) => !search || f.full_name?.toLowerCase().includes(search.toLowerCase()) || f.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Screen loading={loading || deptLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search faculty by name or email..."
        placeholderTextColor="#9AA0A6"
      />

      {filtered.map((f: any) => (
        <Card key={f.id}>
          <Text style={styles.name}>{f.full_name}</Text>
          <Text style={styles.meta}>✉️ {f.email}</Text>
          <Text style={styles.meta}>📱 {f.phone || "—"}</Text>
          <View style={styles.pillRow}>
            <View style={[styles.pill, { backgroundColor: f.status === "active" ? "#1B8A3E15" : "#B9860015" }]}>
              <Text style={[styles.pillText, { color: f.status === "active" ? colors.success : colors.warning }]}>{f.status}</Text>
            </View>
            <View style={[styles.pill, { backgroundColor: colors.surfaceLow }]}>
              <Text style={[styles.pillText, { color: colors.primary }]}>{f.role}</Text>
            </View>
          </View>
        </Card>
      ))}
      {filtered.length === 0 && (
        <Card>
          <EmptyState>{faculty.length === 0 ? "No faculty members found in your department." : "No faculty match your search."}</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 6 },
  meta: { fontSize: 12, color: colors.outline, marginTop: 2 },
  pillRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
});
