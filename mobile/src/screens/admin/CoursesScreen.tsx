import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import type { Database } from "@shared/types/database";

type CourseType = Database["public"]["Tables"]["courses"]["Row"]["type"];

const COURSE_TYPES: { value: CourseType; label: string }[] = [
  { value: "core", label: "Core" },
  { value: "elective", label: "Elective" },
  { value: "lab", label: "Lab" },
  { value: "project", label: "Project" },
  { value: "seminar", label: "Seminar" },
];

export default function CoursesScreen() {
  const [courses, setCourses] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [credits, setCredits] = useState("3");
  const [semester, setSemester] = useState("1");
  const [type, setType] = useState<CourseType>("core");
  const [description, setDescription] = useState("");

  const load = async () => {
    const [coursesRes, deptsRes] = await Promise.all([
      supabase.from("courses").select("*, departments:department_id(name), profiles:instructor_id(full_name)").order("code"),
      supabase.from("departments").select("id, name, code").order("name"),
    ]);
    setCourses(coursesRes.data || []);
    setDepartments(deptsRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/admin/create-course", {
        name,
        code,
        departmentId,
        credits: parseInt(credits, 10),
        semester: parseInt(semester, 10),
        type,
        description: description || undefined,
      });
      setName("");
      setCode("");
      setDepartmentId("");
      setCredits("3");
      setSemester("1");
      setType("core");
      setDescription("");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create course.");
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = courses.filter((c: any) => !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.code?.toLowerCase().includes(search.toLowerCase()));

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ Add Course"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Course created successfully!</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>📚 Add Course</Text>
          <Text style={styles.fieldLabel}>Course Name *</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Data Structures" placeholderTextColor="#9AA0A6" />
          <Text style={styles.fieldLabel}>Course Code *</Text>
          <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="e.g. CS201" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Department *</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {departments.map((d: any) => (
              <Pressable key={d.id} style={[styles.chip, departmentId === d.id && styles.chipActive]} onPress={() => setDepartmentId(d.id)}>
                <Text style={[styles.chipText, departmentId === d.id && styles.chipTextActive]}>{d.code}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {COURSE_TYPES.map((t) => (
              <Pressable key={t.value} style={[styles.chip, type === t.value && styles.chipActive]} onPress={() => setType(t.value)}>
                <Text style={[styles.chipText, type === t.value && styles.chipTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Credits</Text>
              <TextInput style={styles.input} value={credits} onChangeText={setCredits} keyboardType="numeric" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Semester</Text>
              <TextInput style={styles.input} value={semester} onChangeText={setSemester} keyboardType="numeric" />
            </View>
          </View>

          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput style={[styles.input, styles.textArea]} value={description} onChangeText={setDescription} placeholder="Course description..." placeholderTextColor="#9AA0A6" multiline numberOfLines={3} />

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !name || !code || !departmentId}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Creating..." : "Create Course"}</Text>
          </Pressable>
        </Card>
      )}

      <TextInput style={styles.search} value={search} onChangeText={setSearch} placeholder="Search courses..." placeholderTextColor="#9AA0A6" />

      {filtered.map((c: any) => (
        <Card key={c.id}>
          <View style={styles.headerRow}>
            <Text style={styles.code}>{c.code}</Text>
            <StatusBadge status={c.status} />
          </View>
          <Text style={styles.name}>{c.name}</Text>
          <Text style={styles.meta}>{c.departments?.name || "—"} • {c.credits} credits • Sem {c.semester}</Text>
          <Text style={styles.meta}>👤 {c.profiles?.full_name || "TBA"}</Text>
        </Card>
      ))}
      {filtered.length === 0 && (
        <Card>
          <EmptyState>No courses found.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  newButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  newButtonText: { color: "#fff", fontWeight: "700" },
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  formTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 6 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  textArea: { minHeight: 70, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  row2: { flexDirection: "row", gap: 12 },
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  code: { fontSize: 13, fontWeight: "800", color: colors.primary },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  meta: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
