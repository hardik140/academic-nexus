import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";

export default function DepartmentsScreen() {
  const [departments, setDepartments] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");

  const [editDept, setEditDept] = useState<any>(null);
  const [selectedHod, setSelectedHod] = useState("");

  const load = async () => {
    const [deptRes, staffRes] = await Promise.all([
      supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
      supabase.from("profiles").select("id, full_name, role").in("role", ["hod", "teacher"]).order("full_name"),
    ]);
    setDepartments(deptRes.data || []);
    setStaff(staffRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/admin/create-department", { name, code, description });
      setName("");
      setCode("");
      setDescription("");
      setShowCreate(false);
      setSuccess("Department created successfully.");
      await load();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create department.");
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (d: any) => {
    setEditDept(d);
    setSelectedHod(d.hod_id || "");
    setError(null);
  };

  const handleAssignHod = async () => {
    if (!editDept) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/admin/assign-hod", { departmentId: editDept.id, hodUserId: selectedHod || null });
      setEditDept(null);
      setSuccess("HOD assigned successfully.");
      await load();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign HOD.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowCreate(!showCreate)}>
        <Text style={styles.newButtonText}>{showCreate ? "Cancel" : "+ Add Department"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ {success}</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showCreate && (
        <Card>
          <Text style={styles.formTitle}>🏢 Add Department</Text>
          <Text style={styles.fieldLabel}>Department Name *</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Computer Science & Engineering" placeholderTextColor="#9AA0A6" />
          <Text style={styles.fieldLabel}>Code *</Text>
          <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="e.g. CSE" placeholderTextColor="#9AA0A6" />
          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput style={[styles.input, styles.textArea]} value={description} onChangeText={setDescription} placeholder="Brief description..." placeholderTextColor="#9AA0A6" multiline numberOfLines={3} />
          <Pressable style={[styles.submitButton, submitting && { opacity: 0.6 }]} onPress={handleCreate} disabled={submitting || !name || !code}>
            <Text style={styles.submitButtonText}>{submitting ? "Creating..." : "Create Department"}</Text>
          </Pressable>
        </Card>
      )}

      {editDept && (
        <Card>
          <Text style={styles.formTitle}>Assign HOD — {editDept.name}</Text>
          <Text style={styles.hint}>Only staff with the HOD or Teacher role are eligible.</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            <Pressable style={[styles.chip, !selectedHod && styles.chipActive]} onPress={() => setSelectedHod("")}>
              <Text style={[styles.chipText, !selectedHod && styles.chipTextActive]}>None</Text>
            </Pressable>
            {staff.map((s: any) => (
              <Pressable key={s.id} style={[styles.chip, selectedHod === s.id && styles.chipActive]} onPress={() => setSelectedHod(s.id)}>
                <Text style={[styles.chipText, selectedHod === s.id && styles.chipTextActive]}>{s.full_name}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.formActions}>
            <Pressable style={styles.cancelButton} onPress={() => setEditDept(null)}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.saveButton, submitting && { opacity: 0.6 }]} onPress={handleAssignHod} disabled={submitting}>
              <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Save"}</Text>
            </Pressable>
          </View>
        </Card>
      )}

      {departments.map((d: any) => (
        <Card key={d.id}>
          <View style={styles.headerRow}>
            <Text style={styles.code}>{d.code}</Text>
            <StatusBadge status={d.status} />
          </View>
          <Text style={styles.name}>{d.name}</Text>
          <Text style={styles.meta}>HOD: {d.profiles?.full_name || "Unassigned"}</Text>
          <Pressable onPress={() => openEdit(d)}>
            <Text style={styles.assignLink}>Assign HOD</Text>
          </Pressable>
        </Card>
      ))}
      {departments.length === 0 && (
        <Card>
          <EmptyState>No departments found.</EmptyState>
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
  hint: { fontSize: 11, color: colors.outline, marginBottom: 8 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  textArea: { minHeight: 70, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  formActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  cancelButton: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.textVariant, fontWeight: "700" },
  saveButton: { flex: 1, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  code: { fontSize: 13, fontWeight: "800", color: colors.primary },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  meta: { fontSize: 12, color: colors.outline, marginBottom: 8 },
  assignLink: { fontSize: 12, fontWeight: "700", color: colors.primary },
});
