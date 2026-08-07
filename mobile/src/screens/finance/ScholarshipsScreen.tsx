import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import { StudentPicker, type StudentOption } from "@/components/StudentPicker";
import type { Database } from "@shared/types/database";

type ScholarshipType = Database["public"]["Tables"]["scholarships"]["Row"]["type"];

const SCHOLARSHIP_TYPES: { value: ScholarshipType; label: string }[] = [
  { value: "merit", label: "Merit" },
  { value: "need", label: "Need-based" },
  { value: "sports", label: "Sports" },
  { value: "government", label: "Government" },
  { value: "corporate", label: "Corporate" },
  { value: "other", label: "Other" },
];

export default function ScholarshipsScreen() {
  const [scholarships, setScholarships] = useState<any[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [studentId, setStudentId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<ScholarshipType>("merit");
  const [amount, setAmount] = useState("");
  const [academicYear, setAcademicYear] = useState("");

  const load = async () => {
    const [scholarshipsRes, studentsRes] = await Promise.all([
      supabase.from("scholarships").select("*, students:student_id(enrollment_number, profiles:user_id(full_name))").order("awarded_date", { ascending: false }),
      supabase.from("students").select("id, enrollment_number, profiles:user_id(full_name)").order("enrollment_number"),
    ]);
    setScholarships(scholarshipsRes.data || []);
    setStudents(
      (studentsRes.data || []).map((s: any) => ({ id: s.id, label: `${s.enrollment_number} — ${s.profiles?.full_name || ""}` }))
    );
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
      await apiPost("/api/mobile/finance/scholarship", {
        studentId,
        name,
        type,
        amount: Number(amount),
        academicYear: academicYear || undefined,
      });
      setStudentId("");
      setName("");
      setType("merit");
      setAmount("");
      setAcademicYear("");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to award scholarship.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ Award Scholarship"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Scholarship awarded successfully!</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>🎓 Award Scholarship</Text>

          <Text style={styles.fieldLabel}>Student *</Text>
          <StudentPicker students={students} value={studentId} onChange={setStudentId} />

          <Text style={styles.fieldLabel}>Scholarship Name *</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Dean's Merit Award" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {SCHOLARSHIP_TYPES.map((t) => (
              <Pressable key={t.value} style={[styles.chip, type === t.value && styles.chipActive]} onPress={() => setType(t.value)}>
                <Text style={[styles.chipText, type === t.value && styles.chipTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Amount *</Text>
          <TextInput style={styles.input} value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor="#9AA0A6" keyboardType="numeric" />

          <Text style={styles.fieldLabel}>Academic Year</Text>
          <TextInput style={styles.input} value={academicYear} onChangeText={setAcademicYear} placeholder="e.g. 2025-26" placeholderTextColor="#9AA0A6" />

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !studentId || !name || !amount}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Award Scholarship"}</Text>
          </Pressable>
        </Card>
      )}

      {scholarships.map((s: any) => (
        <Card key={s.id}>
          <View style={styles.headerRow}>
            <Text style={styles.rowTitle}>{s.students?.profiles?.full_name || "—"}</Text>
            <StatusBadge status={s.status} />
          </View>
          <Text style={styles.rowSub}>{s.name} • {s.type}</Text>
          <Text style={styles.amountText}>{formatCurrency(s.amount)} {s.awarded_date ? `• ${formatDate(s.awarded_date)}` : ""}</Text>
        </Card>
      ))}
      {scholarships.length === 0 && (
        <Card>
          <EmptyState>No scholarships awarded yet.</EmptyState>
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
  formTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 10 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  chipRow: { flexDirection: "row", marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2, textTransform: "capitalize" },
  amountText: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 6 },
});
