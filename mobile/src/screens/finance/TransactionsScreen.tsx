import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import type { Database } from "@shared/types/database";

type PaymentMethod = Database["public"]["Tables"]["payments"]["Row"]["method"];

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "netbanking", label: "Net Banking" },
  { value: "cheque", label: "Cheque" },
  { value: "dd", label: "Demand Draft" },
  { value: "scholarship", label: "Scholarship" },
  { value: "other", label: "Other" },
];

export default function TransactionsScreen() {
  const [fees, setFees] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [tab, setTab] = useState<"invoices" | "payments">("invoices");
  const [stats, setStats] = useState({ total: 0, collected: 0, pending: 0, overdue: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [payFee, setPayFee] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [transactionRef, setTransactionRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const load = async () => {
    const [feesRes, paymentsRes] = await Promise.all([
      supabase.from("fees").select("*, students(enrollment_number, profiles:user_id(full_name))").order("due_date", { ascending: false }),
      supabase.from("payments").select("*, students(enrollment_number, profiles:user_id(full_name))").order("created_at", { ascending: false }),
    ]);
    const f = (feesRes.data as any[]) || [];
    setFees(f);
    setPayments(paymentsRes.data || []);
    setStats({
      total: f.reduce((s, i) => s + (i.amount || 0), 0),
      collected: f.reduce((s, i) => s + (i.paid_amount || 0), 0),
      pending: f.filter((i) => i.status === "pending").reduce((s, i) => s + (i.amount - i.paid_amount), 0),
      overdue: f.filter((i) => i.status === "overdue").reduce((s, i) => s + (i.amount - i.paid_amount), 0),
    });
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openRecordPayment = (fee: any) => {
    setPayFee(fee);
    setAmount((fee.amount - fee.paid_amount).toFixed(2));
    setMethod("cash");
    setTransactionRef("");
    setError(null);
  };

  const handleRecordPayment = async () => {
    if (!payFee) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/finance/payment", {
        feeId: payFee.id,
        amount: Number(amount),
        method,
        transactionRef: transactionRef || undefined,
      });
      setPayFee(null);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record payment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Payment recorded successfully!</Text>
        </View>
      )}
      {error && !payFee && <ErrorBanner message={error} />}

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Total</Text>
          <Text style={styles.kpiValue}>{formatCurrency(stats.total)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Collected</Text>
          <Text style={[styles.kpiValue, { color: colors.success }]}>{formatCurrency(stats.collected)}</Text>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Pending</Text>
          <Text style={[styles.kpiValue, { color: colors.warning }]}>{formatCurrency(stats.pending)}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Overdue</Text>
          <Text style={[styles.kpiValue, { color: colors.error }]}>{formatCurrency(stats.overdue)}</Text>
        </Card>
      </View>

      {payFee && (
        <Card>
          <Text style={styles.formTitle}>
            💳 Record Payment — {payFee.students?.profiles?.full_name || ""}
          </Text>
          <Text style={styles.rowSub}>Outstanding: {formatCurrency(payFee.amount - payFee.paid_amount)}</Text>
          {error && <ErrorBanner message={error} />}

          <Text style={styles.fieldLabel}>Amount *</Text>
          <TextInput style={styles.input} value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor="#9AA0A6" keyboardType="numeric" />

          <Text style={styles.fieldLabel}>Method</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {PAYMENT_METHODS.map((m) => (
              <Pressable key={m.value} style={[styles.chip, method === m.value && styles.chipActive]} onPress={() => setMethod(m.value)}>
                <Text style={[styles.chipText, method === m.value && styles.chipTextActive]}>{m.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Transaction Reference</Text>
          <TextInput style={styles.input} value={transactionRef} onChangeText={setTransactionRef} placeholder="Optional" placeholderTextColor="#9AA0A6" />

          <View style={styles.formActions}>
            <Pressable style={styles.cancelButton} onPress={() => setPayFee(null)}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.submitButton, submitting && { opacity: 0.6 }]}
              onPress={handleRecordPayment}
              disabled={submitting || !amount}
            >
              <Text style={styles.submitButtonText}>{submitting ? "Recording..." : "Confirm Payment"}</Text>
            </Pressable>
          </View>
        </Card>
      )}

      <View style={styles.tabRow}>
        {(["invoices", "payments"] as const).map((t) => (
          <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {tab === "invoices" ? (
        <Card>
          {fees.length > 0 ? (
            fees.map((row: any) => (
              <View key={row.id} style={styles.row}>
                <View style={styles.headerRow}>
                  <Text style={styles.rowTitle}>{row.students?.profiles?.full_name || "—"}</Text>
                  <StatusBadge status={row.status} />
                </View>
                <Text style={styles.rowSub}>{row.type} • Due {formatDate(row.due_date)}</Text>
                <Text style={styles.amountText}>{formatCurrency(row.paid_amount)} / {formatCurrency(row.amount)}</Text>
                {!["paid", "waived", "refunded"].includes(row.status) && (
                  <Pressable style={styles.payButton} onPress={() => openRecordPayment(row)}>
                    <Text style={styles.payButtonText}>Record Payment</Text>
                  </Pressable>
                )}
              </View>
            ))
          ) : (
            <EmptyState>No invoices raised yet.</EmptyState>
          )}
        </Card>
      ) : (
        <Card>
          {payments.length > 0 ? (
            payments.map((row: any) => (
              <View key={row.id} style={styles.row}>
                <View style={styles.headerRow}>
                  <Text style={styles.rowTitle}>{row.students?.profiles?.full_name || "—"}</Text>
                  <Text style={styles.paymentAmount}>{formatCurrency(row.amount)}</Text>
                </View>
                <Text style={styles.rowSub}>{row.method} • {formatDate(row.created_at)}</Text>
              </View>
            ))
          ) : (
            <EmptyState>No payments recorded yet.</EmptyState>
          )}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 16, fontWeight: "800", color: colors.text },
  tabRow: { flexDirection: "row", gap: 8 },
  tab: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.surfaceLow },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.textVariant, textTransform: "capitalize" },
  tabTextActive: { color: "#fff" },
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
  amountText: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 4 },
  paymentAmount: { fontSize: 14, fontWeight: "800", color: colors.success },
  payButton: { marginTop: 8, alignSelf: "flex-start" },
  payButtonText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  formTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 6 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  chipRow: { flexDirection: "row", marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  formActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  cancelButton: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.textVariant, fontWeight: "700" },
  submitButton: { flex: 1, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
});
