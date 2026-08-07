import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, CardTitle, EmptyState, StatusBadge, colors } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";

export default function FeesScreen() {
  const { student, loading: studentLoading } = useStudent();
  const [fees, setFees] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!student?.id) return;
    const [feesRes, paymentsRes] = await Promise.all([
      supabase.from("fees").select("*").eq("student_id", student.id).order("due_date", { ascending: false }),
      supabase.from("payments").select("*").eq("student_id", student.id).order("created_at", { ascending: false }),
    ]);
    setFees(feesRes.data || []);
    setPayments(paymentsRes.data || []);
    setLoading(false);
  };

  useEffect(() => {
    if (!studentLoading) load();
  }, [studentLoading, student?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const totalBilled = fees.reduce((s, f) => s + f.amount, 0);
  const totalPaid = fees.reduce((s, f) => s + f.paid_amount, 0);
  const totalDue = totalBilled - totalPaid;
  const overdueCount = fees.filter((f) => f.status === "overdue").length;

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Total Billed</Text>
          <Text style={styles.kpiValue}>{formatCurrency(totalBilled)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Total Paid</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>{formatCurrency(totalPaid)}</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Outstanding</Text>
          <Text style={[styles.kpiValue, { color: totalDue > 0 ? colors.warning : colors.success }]}>{formatCurrency(totalDue)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Overdue</Text>
          <Text style={[styles.kpiValue, { color: colors.error }]}>{overdueCount} invoices</Text>
        </Card>
      </View>

      <Card>
        <CardTitle>Fee Invoices</CardTitle>
        {fees.length > 0 ? (
          fees.map((f: any) => (
            <View key={f.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{f.type}</Text>
                <Text style={styles.rowSub}>Balance {formatCurrency(f.amount - f.paid_amount)} • Due {formatDate(f.due_date)}</Text>
              </View>
              <StatusBadge status={f.status} />
            </View>
          ))
        ) : (
          <EmptyState>No fee records found.</EmptyState>
        )}
      </Card>

      <Card>
        <CardTitle>Payment History</CardTitle>
        {payments.length > 0 ? (
          payments.map((p: any) => (
            <View key={p.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{formatCurrency(p.amount)}</Text>
                <Text style={styles.rowSub}>{p.method} • Ref: {p.transaction_ref || "—"} • {formatDate(p.created_at)}</Text>
              </View>
              <StatusBadge status={p.status} />
            </View>
          ))
        ) : (
          <EmptyState>No payments recorded yet.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 18, fontWeight: "800", color: colors.text },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
