import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, ErrorBanner, colors } from "@/components/ui";
import type { Database } from "@shared/types/database";

type ExamType = Database["public"]["Tables"]["marks"]["Row"]["exam_type"];

const EXAM_TYPES: { value: ExamType; label: string }[] = [
  { value: "internal_1", label: "Internal 1" },
  { value: "internal_2", label: "Internal 2" },
  { value: "midterm", label: "Midterm" },
  { value: "final", label: "Final" },
  { value: "assignment", label: "Assignment" },
  { value: "lab", label: "Lab" },
  { value: "project", label: "Project" },
  { value: "viva", label: "Viva" },
];

export default function GradingScreen() {
  const { session } = useAuth();
  const [courses, setCourses] = useState<any[]>([]);
  const [selectedCourse, setSelectedCourse] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [examType, setExamType] = useState<ExamType>("internal_1");
  const [maxMarks, setMaxMarks] = useState("100");
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user.id) return;
    supabase.from("courses").select("id, name, code").eq("instructor_id", session.user.id).then(({ data }) => {
      setCourses(data || []);
      setLoading(false);
    });
  }, [session?.user.id]);

  const loadStudents = async (courseId: string, exam: ExamType = examType) => {
    setSelectedCourse(courseId);
    const { data: enrollments } = await supabase
      .from("course_enrollments")
      .select("student_id, profiles:student_id(id, full_name)")
      .eq("course_id", courseId)
      .eq("status", "enrolled");

    const list = (enrollments || []).map((e: any) => ({ id: e.student_id, full_name: e.profiles?.full_name || "Unknown" }));
    setStudents(list);

    const studentUserIds = list.map((s: any) => s.id);
    const { data: studentRecords } = await supabase.from("students").select("id, user_id").in("user_id", studentUserIds);
    const studentDbIds = (studentRecords || []).map((s) => s.id);

    const { data: existingMarks } = await supabase
      .from("marks")
      .select("student_id, obtained_marks")
      .eq("course_id", courseId)
      .eq("exam_type", exam)
      .in("student_id", studentDbIds);

    const m: Record<string, string> = {};
    (existingMarks || []).forEach((em: any) => {
      const userRec = (studentRecords || []).find((s) => s.id === em.student_id);
      if (userRec) m[userRec.user_id] = String(em.obtained_marks);
    });
    setMarks(m);
  };

  const handleExamTypeChange = (value: ExamType) => {
    setExamType(value);
    if (selectedCourse) loadStudents(selectedCourse, value);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const studentUserIds = Object.keys(marks);
      const { data: studentRecords } = await supabase.from("students").select("id, user_id").in("user_id", studentUserIds);

      const entries = (studentRecords || [])
        .map((s) => ({ studentDbId: s.id, obtainedMarks: parseFloat(marks[s.user_id] || "0") }))
        .filter((e) => !isNaN(e.obtainedMarks));

      await apiPost("/api/mobile/grading/save", {
        courseId: selectedCourse,
        examType,
        maxMarks: parseFloat(maxMarks),
        entries,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save marks.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen loading={loading}>
      {saved && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Marks saved successfully!</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      <Card>
        <Text style={styles.fieldLabel}>Course</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {courses.map((c) => (
            <Pressable
              key={c.id}
              style={[styles.chip, selectedCourse === c.id && styles.chipActive]}
              onPress={() => loadStudents(c.id)}
            >
              <Text style={[styles.chipText, selectedCourse === c.id && styles.chipTextActive]}>{c.code}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={styles.fieldLabel}>Exam Type</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {EXAM_TYPES.map((t) => (
            <Pressable
              key={t.value}
              style={[styles.chip, examType === t.value && styles.chipActive]}
              onPress={() => handleExamTypeChange(t.value)}
            >
              <Text style={[styles.chipText, examType === t.value && styles.chipTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={styles.fieldLabel}>Max Marks</Text>
        <TextInput style={styles.input} value={maxMarks} onChangeText={setMaxMarks} keyboardType="numeric" />
      </Card>

      {selectedCourse && students.length > 0 && (
        <>
          <Card>
            <Text style={styles.fieldLabel}>
              📝 {EXAM_TYPES.find((t) => t.value === examType)?.label} (Max: {maxMarks})
            </Text>
            {students.map((s: any, i: number) => {
              const obtained = parseFloat(marks[s.id] || "0");
              const max = parseFloat(maxMarks) || 1;
              const pct = (obtained / max) * 100;
              return (
                <View key={s.id} style={styles.studentRow}>
                  <Text style={styles.studentIndex}>{i + 1}.</Text>
                  <Text style={styles.studentName}>{s.full_name}</Text>
                  <TextInput
                    testID="marks-input"
                    style={styles.marksInput}
                    value={marks[s.id] || ""}
                    onChangeText={(v) => setMarks({ ...marks, [s.id]: v })}
                    placeholder="0"
                    placeholderTextColor="#9AA0A6"
                    keyboardType="numeric"
                  />
                  <Text
                    style={[
                      styles.pctText,
                      { color: pct >= 60 ? colors.success : pct >= 40 ? colors.warning : colors.error },
                    ]}
                  >
                    {marks[s.id] ? `${pct.toFixed(0)}%` : "—"}
                  </Text>
                </View>
              );
            })}
          </Card>

          <Pressable style={[styles.saveButton, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
            <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Marks"}</Text>
          </Pressable>
        </>
      )}

      {selectedCourse && students.length === 0 && (
        <Card>
          <EmptyState>Select a course to view enrolled students.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 4, marginBottom: 6 },
  chipRow: { flexDirection: "row", marginBottom: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, width: 100 },
  studentRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE", gap: 8 },
  studentIndex: { fontSize: 12, color: colors.outline, width: 20, textAlign: "right" },
  studentName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.text },
  marksInput: { width: 60, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8, fontSize: 14, textAlign: "center", color: colors.text },
  pctText: { fontSize: 12, fontWeight: "700", width: 40, textAlign: "right" },
  saveButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  saveButtonText: { color: "#fff", fontWeight: "700" },
});
