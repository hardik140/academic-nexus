import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, ErrorBanner, colors } from "@/components/ui";

const AUDIENCES: { value: "all" | "staff" | "students"; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Staff" },
  { value: "students", label: "Students" },
];

export default function DashboardScreen() {
  const { session } = useAuth();
  const { profile } = useProfile();
  const [stats, setStats] = useState({ totalStudents: 0, totalFaculty: 0, totalDepartments: 0 });
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<"all" | "staff" | "students">("all");

  const load = async () => {
    if (!session?.user.id) return;
    const [studentsRes, facultyRes, deptsRes, deptListRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student"),
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "teacher"),
      supabase.from("departments").select("id", { count: "exact", head: true }),
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
    ]);
    setStats({
      totalStudents: studentsRes.count || 0,
      totalFaculty: facultyRes.count || 0,
      totalDepartments: deptsRes.count || 0,
    });
    setDepartments(deptListRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleSend = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPost<{ recipientCount: number }>("/api/mobile/director/announcement", {
        title,
        message,
        audience,
      });
      setTitle("");
      setMessage("");
      setAudience("all");
      setShowForm(false);
      setSuccess(`Announcement sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`);
      setTimeout(() => setSuccess(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send announcement.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>Institutional Overview</Text>
      <Text style={styles.subtitle}>Director&apos;s 360° View • {profile?.full_name}</Text>

      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "📢 Send Announcement"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ {success}</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.fieldLabel}>Audience</Text>
          <View style={styles.chipRow}>
            {AUDIENCES.map((a) => (
              <Pressable key={a.value} style={[styles.chip, audience === a.value && styles.chipActive]} onPress={() => setAudience(a.value)}>
                <Text style={[styles.chipText, audience === a.value && styles.chipTextActive]}>{a.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Title *</Text>
          <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Campus Update" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Message *</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={message}
            onChangeText={setMessage}
            placeholder="Write your announcement..."
            placeholderTextColor="#9AA0A6"
            multiline
            numberOfLines={4}
          />

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSend}
            disabled={submitting || !title || !message}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Sending..." : "Send"}</Text>
          </Pressable>
        </Card>
      )}

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Enrollment</Text>
          <Text style={styles.kpiValue}>{stats.totalStudents}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Faculty</Text>
          <Text style={styles.kpiValue}>{stats.totalFaculty}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Depts</Text>
          <Text style={styles.kpiValue}>{stats.totalDepartments}</Text>
        </Card>
      </View>

      <Card>
        <Text style={styles.title}>Department Overview</Text>
        {departments.length > 0 ? (
          departments.map((d: any) => (
            <View key={d.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{d.name}</Text>
                <Text style={styles.rowSub}>{d.code}</Text>
              </View>
              <Text style={styles.hodText}>{d.profiles?.full_name || "—"}</Text>
            </View>
          ))
        ) : (
          <EmptyState>No departments configured.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textVariant, marginBottom: 4 },
  newButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  newButtonText: { color: "#fff", fontWeight: "700" },
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
  chipRow: { flexDirection: "row", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  textArea: { minHeight: 90, textAlignVertical: "top" },
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1, alignItems: "center" },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 20, fontWeight: "800", color: colors.text },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  hodText: { fontSize: 12, color: colors.textVariant },
});
