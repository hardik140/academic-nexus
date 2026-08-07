import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import type { Database } from "@shared/types/database";

type ComplaintCategory = Database["public"]["Tables"]["complaints"]["Row"]["category"];

const HOSTEL_CATEGORIES: ComplaintCategory[] = ["hostel", "mess", "plumbing", "electrical", "ac_hvac", "carpentry", "cleaning", "safety"];

const PRIORITY_COLORS: Record<string, string> = {
  critical: colors.error,
  high: colors.warning,
};

export default function ComplaintsScreen() {
  const [complaints, setComplaints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("complaints")
      .select("*, profiles:submitted_by(full_name)")
      .in("category", HOSTEL_CATEGORIES)
      .order("created_at", { ascending: false });
    setComplaints(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const updateStatus = async (id: string, status: "in_progress" | "resolved") => {
    setActingId(id);
    setError(null);
    try {
      await apiPost("/api/mobile/complaints/status", { complaintId: id, status });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update complaint.");
    } finally {
      setActingId(null);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {error && <ErrorBanner message={error} />}

      <Card>
        <Text style={styles.title}>🛠️ Hostel Complaints</Text>
        {complaints.length > 0 ? (
          complaints.map((c: any) => (
            <View key={c.id} style={styles.row}>
              <View style={styles.headerRow}>
                <Text style={styles.categoryPill}>{c.category.replace(/_/g, " ")}</Text>
                <Text style={[styles.priorityText, { color: PRIORITY_COLORS[c.priority] || colors.info }]}>{c.priority}</Text>
                <StatusBadge status={c.status} />
              </View>
              <Text style={styles.rowTitle}>{c.title}</Text>
              <Text style={styles.rowSub}>Reported by {c.profiles?.full_name || "—"}</Text>
              {(c.status === "open" || c.status === "in_progress") && (
                <View style={styles.actionRow}>
                  {c.status === "open" && (
                    <Pressable
                      style={styles.actionButton}
                      onPress={() => updateStatus(c.id, "in_progress")}
                      disabled={actingId === c.id}
                    >
                      <Text style={styles.actionButtonText}>{actingId === c.id ? "..." : "Start"}</Text>
                    </Pressable>
                  )}
                  {c.status === "in_progress" && (
                    <Pressable
                      style={[styles.actionButton, styles.resolveButton]}
                      onPress={() => updateStatus(c.id, "resolved")}
                      disabled={actingId === c.id}
                    >
                      <Text style={styles.resolveButtonText}>{actingId === c.id ? "..." : "Resolve"}</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          ))
        ) : (
          <EmptyState>No hostel complaints found.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  row: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: "#EEE" },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  categoryPill: { fontSize: 11, fontWeight: "700", color: colors.textVariant, textTransform: "capitalize", backgroundColor: colors.surfaceLow, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  priorityText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize", flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  actionRow: { flexDirection: "row", marginTop: 10 },
  actionButton: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 20 },
  actionButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  resolveButton: { backgroundColor: "#1B8A3E" },
  resolveButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
