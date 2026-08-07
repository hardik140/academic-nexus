import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import { StudentPicker, type StudentOption } from "@/components/StudentPicker";
import type { Database } from "@shared/types/database";

type OfferType = NonNullable<Database["public"]["Tables"]["placements"]["Row"]["offer_type"]>;
type PlacementStatus = Database["public"]["Tables"]["placements"]["Row"]["status"];

const OFFER_TYPES: { value: OfferType; label: string }[] = [
  { value: "full_time", label: "Full-time" },
  { value: "internship", label: "Internship" },
  { value: "ppo", label: "PPO" },
];

const STATUSES: { value: PlacementStatus; label: string }[] = [
  { value: "placed", label: "Placed" },
  { value: "joined", label: "Joined" },
  { value: "declined", label: "Declined" },
  { value: "offer_revoked", label: "Offer Revoked" },
];

function toDateString(d: Date) {
  return d.toISOString().split("T")[0];
}

export default function PlacementsScreen() {
  const [summary, setSummary] = useState<any>(null);
  const [placements, setPlacements] = useState<any[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [studentId, setStudentId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [packageLpa, setPackageLpa] = useState("");
  const [placementDate, setPlacementDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [offerType, setOfferType] = useState<OfferType>("full_time");
  const [status, setStatus] = useState<PlacementStatus>("placed");

  const load = async () => {
    const [summaryRes, placementsRes, studentsRes] = await Promise.all([
      supabase.from("mv_placement_summary").select("*").maybeSingle(),
      supabase.from("placements").select("*, students:student_id(enrollment_number, profiles:user_id(full_name), departments(name))").order("placement_date", { ascending: false }),
      supabase.from("students").select("id, enrollment_number, profiles:user_id(full_name)").order("enrollment_number"),
    ]);
    setSummary(summaryRes.data);
    setPlacements(placementsRes.data || []);
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
      await apiPost("/api/mobile/director/placement", {
        studentId,
        companyName,
        roleTitle,
        packageLpa: packageLpa ? Number(packageLpa) : null,
        placementDate: toDateString(placementDate),
        offerType,
        status,
      });
      setStudentId("");
      setCompanyName("");
      setRoleTitle("");
      setPackageLpa("");
      setOfferType("full_time");
      setStatus("placed");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add placement record.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ Add Placement Record"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Placement record added!</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>💼 Add Placement Record</Text>

          <Text style={styles.fieldLabel}>Student *</Text>
          <StudentPicker students={students} value={studentId} onChange={setStudentId} />

          <Text style={styles.fieldLabel}>Company *</Text>
          <TextInput style={styles.input} value={companyName} onChangeText={setCompanyName} placeholder="e.g. Acme Corp" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Role *</Text>
          <TextInput style={styles.input} value={roleTitle} onChangeText={setRoleTitle} placeholder="e.g. Software Engineer" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Package (LPA)</Text>
          <TextInput style={styles.input} value={packageLpa} onChangeText={setPackageLpa} placeholder="0.00" placeholderTextColor="#9AA0A6" keyboardType="numeric" />

          <Text style={styles.fieldLabel}>Placement Date *</Text>
          <Pressable style={styles.input} onPress={() => setShowDatePicker(true)}>
            <Text>{placementDate.toLocaleDateString()}</Text>
          </Pressable>
          {showDatePicker && (
            <DateTimePicker
              value={placementDate}
              mode="date"
              onChange={(_, d) => {
                setShowDatePicker(Platform.OS === "ios");
                if (d) setPlacementDate(d);
              }}
            />
          )}

          <Text style={styles.fieldLabel}>Offer Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {OFFER_TYPES.map((t) => (
              <Pressable key={t.value} style={[styles.chip, offerType === t.value && styles.chipActive]} onPress={() => setOfferType(t.value)}>
                <Text style={[styles.chipText, offerType === t.value && styles.chipTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Status</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {STATUSES.map((s) => (
              <Pressable key={s.value} style={[styles.chip, status === s.value && styles.chipActive]} onPress={() => setStatus(s.value)}>
                <Text style={[styles.chipText, status === s.value && styles.chipTextActive]}>{s.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !studentId || !companyName || !roleTitle}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Add Record"}</Text>
          </Pressable>
        </Card>
      )}

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Placed</Text>
          <Text style={styles.kpiValue}>{summary?.total_placed || 0}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Companies</Text>
          <Text style={styles.kpiValue}>{summary?.total_companies || 0}</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Avg Package</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>₹{summary?.avg_package || 0}L</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Max Package</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>₹{summary?.max_package || 0}L</Text>
        </Card>
      </View>

      <Card>
        <Text style={styles.title}>Placement Records</Text>
        {placements.length > 0 ? (
          placements.map((p: any) => (
            <View key={p.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{p.students?.profiles?.full_name || "—"}</Text>
                <Text style={styles.rowSub}>{p.company_name} • {p.role_title}</Text>
                <Text style={styles.rowSub}>{p.students?.departments?.name || "—"}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                {p.package_lpa ? <Text style={styles.packageText}>₹{p.package_lpa}L</Text> : null}
                <StatusBadge status={p.status} />
              </View>
            </View>
          ))
        ) : (
          <EmptyState>No placement records yet.</EmptyState>
        )}
      </Card>
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
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1, alignItems: "center" },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 18, fontWeight: "800", color: colors.text },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  rowItem: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  packageText: { fontSize: 13, fontWeight: "800", color: colors.success },
});
