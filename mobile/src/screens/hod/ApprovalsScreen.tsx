import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useHodDepartment } from "@/hooks/useHodDepartment";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";

export default function ApprovalsScreen() {
  const { department, loading: deptLoading } = useHodDepartment();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!department?.id) {
      setRequests([]);
      setLoading(false);
      return;
    }
    const { data: deptStaff } = await supabase.from("profiles").select("id").eq("department_id", department.id);
    const staffIds = (deptStaff || []).map((s) => s.id);
    if (staffIds.length === 0) {
      setRequests([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("leave_requests")
      .select("*, profiles:requested_by(full_name, email, role)")
      .in("requested_by", staffIds)
      .order("created_at", { ascending: false });
    setRequests(data || []);
    setLoading(false);
  };

  useEffect(() => {
    if (!deptLoading) load();
  }, [deptLoading, department?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleAction = async (id: string, action: "approved" | "rejected") => {
    setActingId(id);
    setError(null);
    try {
      await apiPost("/api/mobile/leave/act", { requestId: id, action });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update request.");
    } finally {
      setActingId(null);
    }
  };

  const pending = requests.filter((r) => r.status === "pending");
  const processed = requests.filter((r) => r.status !== "pending");

  return (
    <Screen loading={loading || deptLoading} refreshing={refreshing} onRefresh={onRefresh}>
      {error && <ErrorBanner message={error} />}

      <Card>
        <Text style={styles.title}>🔔 Pending Requests ({pending.length})</Text>
        {pending.length > 0 ? (
          pending.map((req: any) => (
            <View key={req.id} style={styles.pendingRow}>
              <Text style={styles.rowTitle}>{req.profiles?.full_name}</Text>
              <Text style={styles.rowSub}>{req.profiles?.role} • {req.profiles?.email}</Text>
              <Text style={styles.leaveInfo}>
                <Text style={{ fontWeight: "700" }}>{req.leave_type.replace(/_/g, " ")} Leave</Text>
                {"  •  "}
                {new Date(req.start_date).toLocaleDateString()} → {new Date(req.end_date).toLocaleDateString()}
              </Text>
              <Text style={styles.reason}>&ldquo;{req.reason}&rdquo;</Text>
              <View style={styles.actionRow}>
                <Pressable
                  style={[styles.actionButton, styles.rejectButton]}
                  onPress={() => handleAction(req.id, "rejected")}
                  disabled={actingId === req.id}
                >
                  <Text style={styles.rejectButtonText}>Reject</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionButton, styles.approveButton]}
                  onPress={() => handleAction(req.id, "approved")}
                  disabled={actingId === req.id}
                >
                  <Text style={styles.approveButtonText}>{actingId === req.id ? "..." : "Approve"}</Text>
                </Pressable>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>🎉 No pending requests.</EmptyState>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>🗂️ Processed History ({processed.length})</Text>
        {processed.slice(0, 20).map((req: any) => (
          <View key={req.id} style={styles.rowItem}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>
                {req.profiles?.full_name} — <Text style={{ textTransform: "capitalize" }}>{req.leave_type.replace(/_/g, " ")}</Text>
              </Text>
              <Text style={styles.rowSub}>
                {new Date(req.start_date).toLocaleDateString()} → {new Date(req.end_date).toLocaleDateString()}
              </Text>
            </View>
            <StatusBadge status={req.status} />
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
  leaveInfo: { fontSize: 12, color: colors.textVariant, marginTop: 6 },
  reason: { fontSize: 13, color: colors.textVariant, fontStyle: "italic", marginTop: 4 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  actionButton: { flex: 1, borderRadius: 10, paddingVertical: 8, alignItems: "center" },
  approveButton: { backgroundColor: colors.primary },
  approveButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  rejectButton: { backgroundColor: "#BA1A1A15", borderWidth: 1, borderColor: "#BA1A1A30" },
  rejectButtonText: { color: colors.error, fontWeight: "700", fontSize: 13 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
});
