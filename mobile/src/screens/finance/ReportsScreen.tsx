import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, EmptyState, colors } from "@/components/ui";
import { formatCurrency } from "@/lib/format";

export default function ReportsScreen() {
  const [summary, setSummary] = useState<any>(null);
  const [deptBreakdown, setDeptBreakdown] = useState<any[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [summaryRes, feesRes] = await Promise.all([
      supabase.from("mv_fee_summary").select("*").maybeSingle(),
      supabase.from("fees").select("amount, paid_amount, status, students(departments(name, code))"),
    ]);
    setSummary(summaryRes.data);

    const fees = feesRes.data || [];
    const byDept: Record<string, { name: string; code: string; billed: number; collected: number }> = {};
    fees.forEach((f: any) => {
      const dept = f.students?.departments;
      if (!dept) return;
      if (!byDept[dept.code]) byDept[dept.code] = { name: dept.name, code: dept.code, billed: 0, collected: 0 };
      byDept[dept.code].billed += f.amount;
      byDept[dept.code].collected += f.paid_amount;
    });
    setDeptBreakdown(Object.values(byDept));

    const counts: Record<string, number> = {};
    fees.forEach((f: any) => { counts[f.status] = (counts[f.status] || 0) + 1; });
    setStatusCounts(counts);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Billed</Text>
          <Text style={styles.kpiValue}>{formatCurrency(summary?.total_billed || 0)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Collected</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>{formatCurrency(summary?.total_collected || 0)}</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Outstanding</Text>
          <Text style={[styles.kpiValue, { color: colors.error }]}>{formatCurrency(summary?.total_overdue || 0)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Collection Rate</Text>
          <Text style={[styles.kpiValue, { color: colors.primary }]}>{summary?.collection_pct || 0}%</Text>
        </Card>
      </View>

      <Card>
        <Text style={styles.title}>Collection by Department</Text>
        {deptBreakdown.length > 0 ? (
          deptBreakdown.map((d: any) => {
            const pct = d.billed > 0 ? Math.min((d.collected / d.billed) * 100, 100) : 0;
            return (
              <View key={d.code} style={styles.deptRow}>
                <View style={styles.deptHeader}>
                  <Text style={styles.deptName}>{d.code} <Text style={styles.deptFullName}>{d.name}</Text></Text>
                  <Text style={styles.deptAmount}>{formatCurrency(d.collected)} / {formatCurrency(d.billed)}</Text>
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${pct}%` }]} />
                </View>
              </View>
            );
          })
        ) : (
          <EmptyState>No fee data available yet.</EmptyState>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>Invoices by Status</Text>
        <View style={styles.statusGrid}>
          {Object.entries(statusCounts).map(([status, count]) => (
            <View key={status} style={styles.statusChip}>
              <Text style={styles.statusChipLabel}>{status}</Text>
              <Text style={styles.statusChipCount}>{count}</Text>
            </View>
          ))}
          {Object.keys(statusCounts).length === 0 && <EmptyState>No invoices yet.</EmptyState>}
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 16, fontWeight: "800", color: colors.text },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  deptRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  deptHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  deptName: { fontSize: 13, fontWeight: "700", color: colors.text },
  deptFullName: { fontSize: 11, fontWeight: "400", color: colors.outline },
  deptAmount: { fontSize: 12, fontWeight: "700", color: colors.text },
  barTrack: { height: 6, backgroundColor: colors.surfaceLow, borderRadius: 999, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: colors.primary, borderRadius: 999 },
  statusGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: colors.surfaceLow, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minWidth: "45%" },
  statusChipLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, textTransform: "capitalize" },
  statusChipCount: { fontSize: 13, fontWeight: "800", color: colors.text },
});
