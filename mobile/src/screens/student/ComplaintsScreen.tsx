import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import type { MoreStackParamList } from "@/navigation/StudentTabNavigator";

const CATEGORIES = [
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "ac_hvac", label: "AC / HVAC" },
  { value: "carpentry", label: "Carpentry" },
  { value: "cleaning", label: "Cleaning" },
  { value: "internet", label: "Internet / WiFi" },
  { value: "safety", label: "Safety" },
  { value: "academic", label: "Academic" },
  { value: "hostel", label: "Hostel" },
  { value: "mess", label: "Mess / Food" },
  { value: "other", label: "Other" },
];
const PRIORITIES = ["low", "medium", "high", "critical"];

export default function ComplaintsScreen() {
  const route = useRoute<RouteProp<MoreStackParamList, "Complaints">>();
  const prefillCategory = route.params?.category;
  const { session } = useAuth();
  const [complaints, setComplaints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(!!prefillCategory);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [category, setCategory] = useState(prefillCategory ?? "");
  const [priority, setPriority] = useState("medium");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");

  const load = async () => {
    if (!session?.user.id) return;
    const { data } = await supabase.from("complaints").select("*").eq("submitted_by", session.user.id).order("created_at", { ascending: false });
    setComplaints(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/complaints/submit", { category, title, description, location, priority });
      setCategory("");
      setTitle("");
      setDescription("");
      setLocation("");
      setPriority("medium");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit complaint.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ New Complaint"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Complaint submitted! We&apos;ll get back to you soon.</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>📝 New Complaint</Text>

          <Text style={styles.fieldLabel}>Category *</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c.value}
                style={[styles.chip, category === c.value && styles.chipActive]}
                onPress={() => setCategory(c.value)}
              >
                <Text style={[styles.chipText, category === c.value && styles.chipTextActive]}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Priority</Text>
          <View style={styles.chipRow}>
            {PRIORITIES.map((p) => (
              <Pressable key={p} style={[styles.chip, priority === p && styles.chipActive]} onPress={() => setPriority(p)}>
                <Text style={[styles.chipText, priority === p && styles.chipTextActive]}>{p}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Title *</Text>
          <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Brief summary of the issue" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Location</Text>
          <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholder="e.g. Room 204, Block A" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Description *</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Detailed description of the issue..."
            placeholderTextColor="#9AA0A6"
            multiline
            numberOfLines={4}
          />

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !category || !title || !description}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Submitting..." : "Submit Complaint"}</Text>
          </Pressable>
        </Card>
      )}

      <Card>
        <Text style={styles.formTitle}>🛠️ My Complaints</Text>
        {complaints.length > 0 ? (
          complaints.map((c: any) => (
            <View key={c.id} style={styles.complaintRow}>
              <View style={styles.complaintHeader}>
                <Text style={styles.categoryPill}>{c.category?.replace(/_/g, " ")}</Text>
                <StatusBadge status={c.status} />
              </View>
              <Text style={styles.rowTitle}>{c.title}</Text>
              <Text style={styles.rowSub} numberOfLines={2}>{c.description}</Text>
              {c.location ? <Text style={styles.rowSub}>📍 {c.location}</Text> : null}
            </View>
          ))
        ) : (
          <EmptyState>No complaints submitted.</EmptyState>
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
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.textVariant, textTransform: "capitalize" },
  chipTextActive: { color: "#fff", fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  complaintRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  complaintHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  categoryPill: { fontSize: 11, fontWeight: "700", color: colors.textVariant, textTransform: "capitalize", backgroundColor: colors.surfaceLow, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
