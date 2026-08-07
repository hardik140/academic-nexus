import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";

export default function GatePassesScreen() {
  const [passes, setPasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .order("created_at", { ascending: false });
    setPasses(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleAction = async (id: string, action: "approved" | "rejected") => {
    setActingId(id);
    setError(null);
    try {
      await apiPost("/api/mobile/gatepass/act", { passId: id, action });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update gate pass.");
    } finally {
      setActingId(null);
    }
  };

  const pending = passes.filter((p) => p.status === "pending");
  const processed = passes.filter((p) => p.status !== "pending");

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {error && <ErrorBanner message={error} />}

      <Card>
        <Text style={styles.title}>Pending Requests ({pending.length})</Text>
        {pending.length > 0 ? (
          pending.map((pass: any) => (
            <View key={pass.id} style={styles.pendingRow}>
              <Text style={styles.rowTitle}>{pass.students?.profiles?.full_name}</Text>
              <Text style={styles.rowSub}>{pass.students?.enrollment_number}</Text>
              <Text style={styles.detail}>{pass.destination} — {pass.reason}</Text>
              <Text style={styles.rowSub}>
                {new Date(pass.exit_time).toLocaleString()} → {new Date(pass.return_time).toLocaleString()}
              </Text>
              <View style={styles.actionRow}>
                <Pressable
                  style={[styles.actionButton, styles.rejectButton]}
                  onPress={() => handleAction(pass.id, "rejected")}
                  disabled={actingId === pass.id}
                >
                  <Text style={styles.rejectButtonText}>Reject</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionButton, styles.approveButton]}
                  onPress={() => handleAction(pass.id, "approved")}
                  disabled={actingId === pass.id}
                >
                  <Text style={styles.approveButtonText}>{actingId === pass.id ? "..." : "Approve"}</Text>
                </Pressable>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>🎉 No pending gate passes.</EmptyState>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>Processed History ({processed.length})</Text>
        {processed.slice(0, 20).map((pass: any) => (
          <View key={pass.id} style={styles.rowItem}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{pass.students?.profiles?.full_name || "—"}</Text>
              <Text style={styles.rowSub}>{pass.destination} • {new Date(pass.exit_time).toLocaleDateString()}</Text>
            </View>
            <StatusBadge status={pass.status} />
          </View>
        ))}
        {processed.length === 0 && <EmptyState>No processed requests yet.</EmptyState>}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  pendingRow: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  detail: { fontSize: 13, color: colors.textVariant, marginTop: 6 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  actionButton: { flex: 1, borderRadius: 10, paddingVertical: 8, alignItems: "center" },
  approveButton: { backgroundColor: colors.primary },
  approveButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  rejectButton: { backgroundColor: "#BA1A1A15", borderWidth: 1, borderColor: "#BA1A1A30" },
  rejectButtonText: { color: colors.error, fontWeight: "700", fontSize: 13 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
});
