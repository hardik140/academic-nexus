import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import type { UserRole } from "@shared/types/database";

const ROLES: { value: UserRole; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "teacher", label: "Teacher" },
  { value: "hod", label: "HOD" },
  { value: "finance", label: "Finance" },
  { value: "director", label: "Director" },
  { value: "admin", label: "Admin" },
  { value: "warden", label: "Warden" },
];

export default function UsersScreen() {
  const [users, setUsers] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<UserRole>("student");
  const [departmentId, setDepartmentId] = useState("");

  const [editUser, setEditUser] = useState<any>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("student");
  const [editPhone, setEditPhone] = useState("");

  const load = async () => {
    const [usersRes, deptsRes] = await Promise.all([
      supabase.from("profiles").select("*, departments:department_id(name)").order("created_at", { ascending: false }),
      supabase.from("departments").select("id, name, code").order("name"),
    ]);
    setUsers(usersRes.data || []);
    setDepartments(deptsRes.data || []);
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
      await apiPost("/api/mobile/admin/create-user", { email, fullName, role, departmentId: departmentId || undefined });
      setEmail("");
      setFullName("");
      setRole("student");
      setDepartmentId("");
      setShowCreate(false);
      setSuccess("User created successfully.");
      await load();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create user.");
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (u: any) => {
    setEditUser(u);
    setEditName(u.full_name || "");
    setEditRole(u.role);
    setEditPhone(u.phone || "");
    setError(null);
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/admin/update-user", {
        targetUserId: editUser.id,
        fullName: editName,
        role: editRole,
        phone: editPhone || undefined,
      });
      setEditUser(null);
      setSuccess("User updated successfully.");
      await load();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update user.");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStatus = async (u: any) => {
    setError(null);
    try {
      await apiPost("/api/mobile/admin/user-status", {
        targetUserId: u.id,
        status: u.status === "active" ? "suspended" : "active",
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status.");
    }
  };

  const filtered = users.filter(
    (u: any) => !search || u.full_name?.toLowerCase().includes(search.toLowerCase()) || u.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowCreate(!showCreate)}>
        <Text style={styles.newButtonText}>{showCreate ? "Cancel" : "+ Add User"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ {success}</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showCreate && (
        <Card>
          <Text style={styles.formTitle}>👤 Add User</Text>
          <Text style={styles.hint}>Creates a real account — the user can sign in immediately with this email.</Text>

          <Text style={styles.fieldLabel}>Full Name *</Text>
          <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholder="e.g. Jane Doe" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Email *</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="jane@college.edu" placeholderTextColor="#9AA0A6" keyboardType="email-address" autoCapitalize="none" />

          <Text style={styles.fieldLabel}>Role</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {ROLES.map((r) => (
              <Pressable key={r.value} style={[styles.chip, role === r.value && styles.chipActive]} onPress={() => setRole(r.value)}>
                <Text style={[styles.chipText, role === r.value && styles.chipTextActive]}>{r.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Department</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            <Pressable style={[styles.chip, !departmentId && styles.chipActive]} onPress={() => setDepartmentId("")}>
              <Text style={[styles.chipText, !departmentId && styles.chipTextActive]}>None</Text>
            </Pressable>
            {departments.map((d: any) => (
              <Pressable key={d.id} style={[styles.chip, departmentId === d.id && styles.chipActive]} onPress={() => setDepartmentId(d.id)}>
                <Text style={[styles.chipText, departmentId === d.id && styles.chipTextActive]}>{d.code}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleCreate}
            disabled={submitting || !email || !fullName}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Creating..." : "Create User"}</Text>
          </Pressable>
        </Card>
      )}

      {editUser && (
        <Card>
          <Text style={styles.formTitle}>Edit User — {editUser.email}</Text>

          <Text style={styles.fieldLabel}>Full Name</Text>
          <TextInput style={styles.input} value={editName} onChangeText={setEditName} placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Role</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {ROLES.map((r) => (
              <Pressable key={r.value} style={[styles.chip, editRole === r.value && styles.chipActive]} onPress={() => setEditRole(r.value)}>
                <Text style={[styles.chipText, editRole === r.value && styles.chipTextActive]}>{r.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Phone</Text>
          <TextInput style={styles.input} value={editPhone} onChangeText={setEditPhone} placeholderTextColor="#9AA0A6" keyboardType="phone-pad" />

          <View style={styles.formActions}>
            <Pressable style={styles.cancelButton} onPress={() => setEditUser(null)}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.saveButton, submitting && { opacity: 0.6 }]} onPress={handleSaveEdit} disabled={submitting}>
              <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Save Changes"}</Text>
            </Pressable>
          </View>
        </Card>
      )}

      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search users..."
        placeholderTextColor="#9AA0A6"
      />

      {filtered.map((u: any) => (
        <Card key={u.id}>
          <View style={styles.headerRow}>
            <Text style={styles.name}>{u.full_name}</Text>
            <StatusBadge status={u.status} />
          </View>
          <Text style={styles.email}>{u.email}</Text>
          <Text style={styles.meta}>{u.role} • {u.departments?.name || "—"}</Text>
          <View style={styles.actionRow}>
            <Pressable onPress={() => openEdit(u)}>
              <Text style={styles.editLink}>Edit</Text>
            </Pressable>
            <Pressable onPress={() => toggleStatus(u)}>
              <Text style={u.status === "active" ? styles.suspendLink : styles.activateLink}>
                {u.status === "active" ? "Suspend" : "Activate"}
              </Text>
            </Pressable>
          </View>
        </Card>
      ))}
      {filtered.length === 0 && (
        <Card>
          <EmptyState>No users found.</EmptyState>
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
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  name: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  email: { fontSize: 12, color: colors.outline },
  meta: { fontSize: 12, color: colors.textVariant, textTransform: "capitalize", marginTop: 2 },
  actionRow: { flexDirection: "row", gap: 16, marginTop: 10 },
  editLink: { fontSize: 12, fontWeight: "700", color: colors.primary },
  suspendLink: { fontSize: 12, fontWeight: "700", color: colors.error },
  activateLink: { fontSize: 12, fontWeight: "700", color: colors.success },
});
