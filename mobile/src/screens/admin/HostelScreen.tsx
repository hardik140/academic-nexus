import { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";

export default function HostelScreen() {
  const [blocks, setBlocks] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [editBlock, setEditBlock] = useState<any>(null);
  const [selectedWarden, setSelectedWarden] = useState("");

  const load = async () => {
    const [blocksRes, staffRes] = await Promise.all([
      supabase.from("hostel_blocks").select("*, profiles:warden_id(full_name)").order("name"),
      supabase.from("profiles").select("id, full_name, role").eq("role", "warden").order("full_name"),
    ]);
    setBlocks(blocksRes.data || []);
    setStaff(staffRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openEdit = (block: any) => {
    setEditBlock(block);
    setSelectedWarden(block.warden_id || "");
    setError(null);
  };

  const handleAssignWarden = async () => {
    if (!editBlock) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/admin/assign-warden", { blockId: editBlock.id, wardenUserId: selectedWarden || null });
      setEditBlock(null);
      setSuccess("Warden assigned successfully.");
      await load();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign warden.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ {success}</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {editBlock && (
        <Card>
          <Text style={styles.formTitle}>Assign Warden — {editBlock.name}</Text>
          <Text style={styles.hint}>Only staff with the Warden role are eligible.</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            <Pressable style={[styles.chip, !selectedWarden && styles.chipActive]} onPress={() => setSelectedWarden("")}>
              <Text style={[styles.chipText, !selectedWarden && styles.chipTextActive]}>None</Text>
            </Pressable>
            {staff.map((s: any) => (
              <Pressable key={s.id} style={[styles.chip, selectedWarden === s.id && styles.chipActive]} onPress={() => setSelectedWarden(s.id)}>
                <Text style={[styles.chipText, selectedWarden === s.id && styles.chipTextActive]}>{s.full_name}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.formActions}>
            <Pressable style={styles.cancelButton} onPress={() => setEditBlock(null)}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.saveButton, submitting && { opacity: 0.6 }]} onPress={handleAssignWarden} disabled={submitting}>
              <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Save"}</Text>
            </Pressable>
          </View>
        </Card>
      )}

      {blocks.map((b: any) => (
        <Card key={b.id}>
          <View style={styles.headerRow}>
            <Text style={styles.name}>{b.name}</Text>
            <StatusBadge status={b.status} />
          </View>
          <Text style={styles.meta}>{b.type} • {b.total_rooms} rooms • {b.floors} floors</Text>
          <Text style={styles.meta}>Warden: {b.profiles?.full_name || "Unassigned"}</Text>
          <Pressable onPress={() => openEdit(b)}>
            <Text style={styles.assignLink}>Assign Warden</Text>
          </Pressable>
        </Card>
      ))}
      {blocks.length === 0 && (
        <Card>
          <EmptyState>No hostel blocks found.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  formTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 6 },
  hint: { fontSize: 11, color: colors.outline, marginBottom: 8 },
  chipRow: { flexDirection: "row", marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  formActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  cancelButton: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.textVariant, fontWeight: "700" },
  saveButton: { flex: 1, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  name: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  meta: { fontSize: 12, color: colors.outline, marginTop: 2 },
  assignLink: { fontSize: 12, fontWeight: "700", color: colors.primary, marginTop: 8 },
});
