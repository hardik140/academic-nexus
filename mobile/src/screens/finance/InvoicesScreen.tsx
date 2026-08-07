import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import { StudentPicker, type StudentOption } from "@/components/StudentPicker";

function toDateString(d: Date) {
  return d.toISOString().split("T")[0];
}

export default function InvoicesScreen() {
  const [fees, setFees] = useState<any[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [studentId, setStudentId] = useState("");
  const [type, setType] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [academicYear, setAcademicYear] = useState("");

  const load = async () => {
    const [feesRes, studentsRes] = await Promise.all([
      supabase.from("fees").select("*, students:student_id(enrollment_number, profiles:user_id(full_name))").order("due_date", { ascending: false }),
      supabase.from("students").select("id, enrollment_number, profiles:user_id(full_name)").order("enrollment_number"),
    ]);
    setFees(feesRes.data || []);
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
      await apiPost("/api/mobile/finance/invoice", {
        studentId,
        type,
        amount: Number(amount),
        dueDate: toDateString(dueDate),
        academicYear: academicYear || undefined,
      });
      setStudentId("");
      setType("");
      setAmount("");
      setAcademicYear("");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to raise invoice.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ Raise Invoice"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Invoice raised successfully!</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>🧾 Raise Invoice</Text>

          <Text style={styles.fieldLabel}>Student *</Text>
          <StudentPicker students={students} value={studentId} onChange={setStudentId} />

          <Text style={styles.fieldLabel}>Fee Type *</Text>
          <TextInput style={styles.input} value={type} onChangeText={setType} placeholder="e.g. Tuition, Hostel, Exam" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Amount *</Text>
          <TextInput style={styles.input} value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor="#9AA0A6" keyboardType="numeric" />

          <Text style={styles.fieldLabel}>Due Date *</Text>
          <Pressable style={styles.input} onPress={() => setShowDatePicker(true)}>
            <Text>{dueDate.toLocaleDateString()}</Text>
          </Pressable>
          {showDatePicker && (
            <DateTimePicker
              value={dueDate}
              mode="date"
              onChange={(_, d) => {
                setShowDatePicker(Platform.OS === "ios");
                if (d) setDueDate(d);
              }}
            />
          )}

          <Text style={styles.fieldLabel}>Academic Year</Text>
          <TextInput style={styles.input} value={academicYear} onChangeText={setAcademicYear} placeholder="e.g. 2025-26" placeholderTextColor="#9AA0A6" />

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !studentId || !type || !amount || !dueDate}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Creating..." : "Raise Invoice"}</Text>
          </Pressable>
        </Card>
      )}

      {fees.map((f: any) => (
        <Card key={f.id}>
          <View style={styles.headerRow}>
            <Text style={styles.rowTitle}>{f.students?.profiles?.full_name || "—"}</Text>
            <StatusBadge status={f.status} />
          </View>
          <Text style={styles.rowSub}>{f.type} • Due {formatDate(f.due_date)}</Text>
          <Text style={styles.amountText}>{formatCurrency(f.paid_amount)} / {formatCurrency(f.amount)}</Text>
        </Card>
      ))}
      {fees.length === 0 && (
        <Card>
          <EmptyState>No invoices raised yet.</EmptyState>
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
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  amountText: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 6 },
});
