import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useProfile } from "@/hooks/useProfile";
import { Screen, Card, CardTitle, EmptyState, colors } from "@/components/ui";
import { formatCurrency } from "@/lib/format";

export default function DashboardScreen() {
  const { profile } = useProfile();
  const [stats, setStats] = useState({ totalBilled: 0, totalCollected: 0, totalOverdue: 0, collectionRate: 0 });
  const [recentPayments, setRecentPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [feesRes, paymentsRes] = await Promise.all([
      supabase.from("fees").select("amount, paid_amount, status"),
      supabase.from("payments").select("*, profiles:student_id(full_name)").order("created_at", { ascending: false }).limit(10),
    ]);
    const allFees = feesRes.data || [];
    const totalBilled = allFees.reduce((s, f) => s + f.amount, 0);
    const totalCollected = allFees.reduce((s, f) => s + f.paid_amount, 0);
    const totalOverdue = allFees.filter((f) => f.status === "overdue").reduce((s, f) => s + (f.amount - f.paid_amount), 0);
    const collectionRate = totalBilled > 0 ? (totalCollected / totalBilled) * 100 : 0;
    setStats({ totalBilled, totalCollected, totalOverdue, collectionRate });
    setRecentPayments(paymentsRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>Finance Dashboard</Text>
      <Text style={styles.subtitle}>Welcome back, {profile?.full_name?.split(" ")[0] || "Finance"}</Text>

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Total Billed</Text>
          <Text style={styles.kpiValue}>{formatCurrency(stats.totalBilled)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Collected</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>{formatCurrency(stats.totalCollected)}</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Overdue</Text>
          <Text style={[styles.kpiValue, { color: colors.error }]}>{formatCurrency(stats.totalOverdue)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Collection Rate</Text>
          <Text style={[styles.kpiValue, { color: colors.primary }]}>{stats.collectionRate.toFixed(1)}%</Text>
        </Card>
      </View>

      <Card>
        <CardTitle>Recent Transactions</CardTitle>
        {recentPayments.length > 0 ? (
          recentPayments.map((p: any) => (
            <View key={p.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{p.profiles?.full_name || "—"}</Text>
                <Text style={styles.rowSub}>{formatCurrency(p.amount)} • {p.method}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: p.status === "cleared" ? "#1B8A3E20" : "#B9860020" }]}>
                <Text style={[styles.statusPillText, { color: p.status === "cleared" ? colors.success : colors.warning }]}>{p.status}</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>No transactions recorded yet.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textVariant, marginBottom: 4 },
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 18, fontWeight: "800", color: colors.text },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
});
