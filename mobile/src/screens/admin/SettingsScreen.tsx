import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { apiPost } from "@/lib/api";
import { Screen, Card, ErrorBanner, colors } from "@/components/ui";

const EMPTY_FORM = {
  name: "", code: "", domain: "", accreditation: "", established_year: "",
  email: "", phone: "", website: "", address: "", city: "", state: "", country: "",
};

export default function SettingsScreen() {
  const { session } = useAuth();
  const [college, setCollege] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = async () => {
    if (!session?.user.id) return;
    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", session.user.id).single();
    if (!profile) {
      setLoading(false);
      return;
    }
    const { data } = await supabase.from("colleges").select("*").eq("id", profile.college_id).single();
    setCollege(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openEdit = () => {
    if (college) {
      setForm({
        name: college.name || "",
        code: college.code || "",
        domain: college.domain || "",
        accreditation: college.accreditation || "",
        established_year: college.established_year ? String(college.established_year) : "",
        email: college.email || "",
        phone: college.phone || "",
        website: college.website || "",
        address: college.address || "",
        city: college.city || "",
        state: college.state || "",
        country: college.country || "",
      });
    }
    setError(null);
    setShowEdit(true);
  };

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/admin/update-college", {
        name: form.name,
        code: form.code,
        domain: form.domain || undefined,
        accreditation: form.accreditation || undefined,
        established_year: form.established_year ? Number(form.established_year) : undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        website: form.website || undefined,
        address: form.address || undefined,
        city: form.city || undefined,
        state: form.state || undefined,
        country: form.country || undefined,
      });
      setShowEdit(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update settings.");
    } finally {
      setSubmitting(false);
    }
  };

  const fields: [string, string][] = college
    ? [
        ["Institution Name", college.name],
        ["Code", college.code],
        ["Domain", college.domain],
        ["Accreditation", college.accreditation],
        ["Established", college.established_year],
        ["Email", college.email],
        ["Phone", college.phone],
        ["Website", college.website],
        ["Address", college.address],
        ["City", college.city],
        ["State", college.state],
        ["Country", college.country],
      ]
    : [];

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={openEdit}>
        <Text style={styles.newButtonText}>Edit Institution Settings</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Settings updated successfully!</Text>
        </View>
      )}
      {error && !showEdit && <ErrorBanner message={error} />}

      {showEdit && (
        <Card>
          <Text style={styles.formTitle}>Edit Institution Settings</Text>
          {error && <ErrorBanner message={error} />}

          {([
            ["Institution Name *", "name"],
            ["Code *", "code"],
            ["Domain", "domain"],
            ["Accreditation", "accreditation"],
            ["Established Year", "established_year"],
            ["Email", "email"],
            ["Phone", "phone"],
            ["Website", "website"],
            ["Address", "address"],
            ["City", "city"],
            ["State", "state"],
            ["Country", "country"],
          ] as const).map(([label, key]) => (
            <View key={key}>
              <Text style={styles.fieldLabel}>{label}</Text>
              <TextInput
                style={styles.input}
                value={(form as any)[key]}
                onChangeText={(v) => setForm({ ...form, [key]: v })}
                placeholderTextColor="#9AA0A6"
                keyboardType={key === "established_year" ? "numeric" : "default"}
              />
            </View>
          ))}

          <View style={styles.formActions}>
            <Pressable style={styles.cancelButton} onPress={() => setShowEdit(false)}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.saveButton, submitting && { opacity: 0.6 }]}
              onPress={handleSave}
              disabled={submitting || !form.name || !form.code}
            >
              <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Save Changes"}</Text>
            </Pressable>
          </View>
        </Card>
      )}

      <Card>
        <Text style={styles.title}>Institution Profile</Text>
        {fields.map(([label, value]) => (
          <View key={label} style={styles.fieldRow}>
            <Text style={styles.fieldRowLabel}>{label}</Text>
            <Text style={styles.fieldRowValue}>{value || "—"}</Text>
          </View>
        ))}
      </Card>
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
  formActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  cancelButton: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.textVariant, fontWeight: "700" },
  saveButton: { flex: 1, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  fieldRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  fieldRowLabel: { fontSize: 10, fontWeight: "700", color: colors.outline, textTransform: "uppercase" },
  fieldRowValue: { fontSize: 14, color: colors.text, marginTop: 2 },
});
